import type { App } from "@src/app";
import {
	events,
	type StatusDatabase,
	sessions,
	summaries,
} from "@src/database";
import type {
	Harness,
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	SourceRead,
} from "@src/harnesses";
import { and, eq, gte, inArray, ne, notInArray, or } from "drizzle-orm";

export async function sync(app: App, since: Date): Promise<SyncReport> {
	const report: SyncReport = {
		sources: 0,
		sessions: 0,
		events: 0,
		warnings: [],
		failures: [],
	};
	for (const adapter of app.adapters) {
		const listed = await ingest(app, adapter, since, report);
		await observe(app, adapter, since, listed, report);
	}
	return report;
}

async function ingest(
	app: App,
	adapter: HarnessAdapter,
	since: Date,
	report: SyncReport,
): Promise<string[]> {
	const { harness } = adapter;
	let paths: string[];
	try {
		paths = await adapter.listSources(since);
	} catch (error) {
		report.failures.push(issue(harness, "list", null, error));
		return [];
	}
	app.progress(`syncing ${paths.length} ${harness} sources`);
	for (const path of paths) {
		try {
			const read = await adapter.readSource(
				path,
				ingestedSource(app.database, path),
			);
			report.sources += 1;
			if (read === null) {
				continue;
			}
			for (const message of read.warnings) {
				report.warnings.push(issue(harness, "read", path, message));
			}
			if (read.continuedIn !== undefined) {
				dropContinuedSession(
					app.database,
					path,
					read.session.id,
					read.continuedIn,
				);
				continue;
			}
			const unmatchedResults = store(app.database, path, read);
			report.sessions += 1;
			report.events += read.events.length - unmatchedResults.length;
			for (const message of unmatchedResults) {
				report.warnings.push(issue(harness, "read", path, message));
			}
		} catch (error) {
			report.failures.push(issue(harness, "read", path, error));
		}
	}
	return paths;
}

function ingestedSource(
	database: StatusDatabase,
	path: string,
): IngestedSource | null {
	const row = sessionBySourcePath(database, path);
	return row ? { session: toRecord(row), readOffset: row.readOffset } : null;
}

function dropContinuedSession(
	database: StatusDatabase,
	path: string,
	replacedId: string,
	continuationId: string,
) {
	database.transaction(
		(transaction) => {
			const stored = storedSourceOf(transaction, replacedId);
			if (stored && stored.sourcePath !== path) {
				throw new Error(
					`${replacedId} is already stored from ${stored.sourcePath}`,
				);
			}
			transaction
				.update(sessions)
				.set({ parentId: continuationId })
				.where(eq(sessions.parentId, replacedId))
				.run();
			transaction
				.delete(summaries)
				.where(eq(summaries.sessionId, replacedId))
				.run();
			transaction.delete(events).where(eq(events.sessionId, replacedId)).run();
			transaction.delete(sessions).where(eq(sessions.id, replacedId)).run();
		},
		{ behavior: "immediate" },
	);
}

function store(
	database: StatusDatabase,
	path: string,
	read: SourceRead,
): string[] {
	const { session } = read;
	return database.transaction(
		(transaction) => {
			const stored = storedSourceOf(transaction, session.id);
			if (stored && stored.sourcePath !== path) {
				throw new Error(
					`${session.id} is already stored from ${stored.sourcePath}`,
				);
			}
			const lastEventAt = newest([
				stored?.lastEventAt ?? session.startedAt,
				...read.events.map((event) => event.at),
			]);
			upsertSession(transaction, session, {
				lastEventAt,
				sourcePath: path,
				readOffset: read.nextOffset,
			});
			const unmatchedResults: string[] = [];
			for (const event of read.events) {
				if (event.kind !== "tool_result") {
					upsertEvent(transaction, session.id, event);
					continue;
				}
				if (!finishToolCall(transaction, session.id, event)) {
					unmatchedResults.push(
						`tool result ${event.key} has no stored call, so it was dropped`,
					);
				}
			}
			return unmatchedResults;
		},
		{ behavior: "immediate" },
	);
}

function upsertSession(
	transaction: Transaction,
	session: SessionRecord,
	progress: { lastEventAt: Date; sourcePath: string; readOffset: number },
) {
	const transcriptFields = {
		harness: session.harness,
		surface: session.surface,
		parentId: session.parentId,
		title: session.title,
		cwd: session.cwd,
		branch: session.branch,
		startedAt: session.startedAt,
		...progress,
	};
	transaction
		.insert(sessions)
		.values({
			id: session.id,
			...transcriptFields,
			state: "ended",
			observedAt: progress.lastEventAt,
		})
		.onConflictDoUpdate({ target: sessions.id, set: transcriptFields })
		.run();
}

function upsertEvent(
	transaction: Transaction,
	sessionId: string,
	event: Exclude<SessionEvent, { kind: "tool_result" }>,
) {
	const fields = eventFields(event);
	transaction
		.insert(events)
		.values({
			sessionId,
			key: event.key,
			...fields,
			toolStatus: event.kind === "tool_call" ? "pending" : null,
		})
		.onConflictDoUpdate({
			target: [events.sessionId, events.key],
			set: fields,
		})
		.run();
}

function eventFields(event: Exclude<SessionEvent, { kind: "tool_result" }>) {
	if (event.kind === "message") {
		return { at: event.at, role: event.role, text: event.text };
	}
	return {
		at: event.at,
		role: "tool" as const,
		text: event.text,
		toolName: event.toolName,
		toolTarget: event.toolTarget,
	};
}

function finishToolCall(
	transaction: Transaction,
	sessionId: string,
	result: Extract<SessionEvent, { kind: "tool_result" }>,
): boolean {
	const updated = transaction
		.update(events)
		.set({ toolStatus: result.toolStatus })
		.where(
			and(
				eq(events.sessionId, sessionId),
				eq(events.key, result.key),
				eq(events.role, "tool"),
			),
		)
		.returning({ id: events.id })
		.all();
	return updated.length > 0;
}

async function observe(
	app: App,
	adapter: HarnessAdapter,
	since: Date,
	listed: string[],
	report: SyncReport,
) {
	const { harness } = adapter;
	try {
		const candidates = recentlyActiveSessions(
			app.database,
			harness,
			since,
			listed,
		);
		const { snapshots, warnings } = await adapter.snapshot(
			candidates.map(toRecord),
		);
		for (const message of warnings) {
			report.warnings.push(issue(harness, "snapshot", null, message));
		}
		const candidateIds = new Set(candidates.map((row) => row.id));
		const observedAt = app.now();
		app.database.transaction((transaction) => {
			for (const snapshot of snapshots) {
				if (!candidateIds.has(snapshot.sessionId)) {
					report.warnings.push(
						issue(
							harness,
							"snapshot",
							null,
							`snapshot returned ${snapshot.sessionId}, which it wasn't asked about`,
						),
					);
					continue;
				}
				recordLiveState(transaction, snapshot, observedAt);
			}
			endUnseenSessions(
				transaction,
				[...candidateIds],
				snapshots.map((snapshot) => snapshot.sessionId),
				observedAt,
			);
		});
	} catch (error) {
		report.failures.push(issue(harness, "snapshot", null, error));
	}
}

function recordLiveState(
	transaction: Transaction,
	snapshot: SessionSnapshot,
	observedAt: Date,
) {
	transaction
		.update(sessions)
		.set({
			state: snapshot.state,
			cwd: snapshot.cwd,
			branch: snapshot.branch,
			observedAt,
		})
		.where(eq(sessions.id, snapshot.sessionId))
		.run();
}

function endUnseenSessions(
	transaction: Transaction,
	candidateIds: string[],
	seenIds: string[],
	observedAt: Date,
) {
	transaction
		.update(sessions)
		.set({ state: "ended", observedAt })
		.where(
			and(
				inArray(sessions.id, candidateIds),
				notInArray(sessions.id, seenIds),
				ne(sessions.state, "ended"),
			),
		)
		.run();
}

function toRecord(row: StoredSession): SessionRecord {
	return {
		id: row.id,
		harness: row.harness,
		surface: row.surface,
		parentId: row.parentId,
		title: row.title,
		cwd: row.cwd,
		branch: row.branch,
		startedAt: row.startedAt,
		sourcePath: row.sourcePath,
	};
}

function newest(times: Date[]): Date {
	return new Date(
		times.reduce((latest, time) => Math.max(latest, time.getTime()), 0),
	);
}

function issue(
	harness: Harness,
	step: SyncIssue["step"],
	source: string | null,
	problem: unknown,
): SyncIssue {
	const message = problem instanceof Error ? problem.message : String(problem);
	return { harness, step, source, message };
}

function sessionBySourcePath(
	database: StatusDatabase,
	path: string,
): StoredSession | undefined {
	return database
		.select()
		.from(sessions)
		.where(eq(sessions.sourcePath, path))
		.get();
}

function storedSourceOf(transaction: Transaction, sessionId: string) {
	return transaction
		.select({
			lastEventAt: sessions.lastEventAt,
			sourcePath: sessions.sourcePath,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.get();
}

function recentlyActiveSessions(
	database: StatusDatabase,
	harness: Harness,
	since: Date,
	listed: string[],
): StoredSession[] {
	return database
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.harness, harness),
				or(
					gte(sessions.lastEventAt, since),
					ne(sessions.state, "ended"),
					inArray(sessions.sourcePath, listed),
				),
			),
		)
		.all();
}

export type SyncReport = {
	sources: number;
	sessions: number;
	events: number;
	warnings: SyncIssue[];
	failures: SyncIssue[];
};

export type SyncIssue = {
	harness: Harness;
	step: "list" | "read" | "snapshot";
	source: string | null;
	message: string;
};

type StoredSession = typeof sessions.$inferSelect;

type Transaction = Parameters<Parameters<StatusDatabase["transaction"]>[0]>[0];

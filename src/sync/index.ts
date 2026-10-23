import type { App } from "@src/app";
import { events, sessions } from "@src/database";
import type {
	Harness,
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SourceRead,
} from "@src/harnesses";
import { and, eq, gte, inArray, ne, notInArray, or } from "drizzle-orm";

/** @public */
export type SyncReport = {
	sources: number;
	sessions: number;
	events: number;
	warnings: SyncIssue[];
	failures: SyncIssue[];
};

/** @public */
export type SyncIssue = {
	harness: Harness;
	step: "list" | "read" | "snapshot";
	source: string | null;
	message: string;
};

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
			const read = await adapter.readSource(path, ingestedSource(app, path));
			report.sources += 1;
			if (read === null) {
				continue;
			}
			for (const message of read.warnings) {
				report.warnings.push(issue(harness, "read", path, message));
			}
			const unmatchedResults = store(app, path, read);
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

async function observe(
	app: App,
	adapter: HarnessAdapter,
	since: Date,
	listed: string[],
	report: SyncReport,
) {
	const { harness } = adapter;
	try {
		const candidates = app.database
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
		const snapshots = await adapter.snapshot(candidates.map(toRecord));
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
			transaction
				.update(sessions)
				.set({ state: "ended", observedAt })
				.where(
					and(
						inArray(sessions.id, [...candidateIds]),
						notInArray(
							sessions.id,
							snapshots.map((snapshot) => snapshot.sessionId),
						),
						ne(sessions.state, "ended"),
					),
				)
				.run();
		});
	} catch (error) {
		report.failures.push(issue(harness, "snapshot", null, error));
	}
}

function ingestedSource(app: App, path: string): IngestedSource | null {
	const row = app.database
		.select()
		.from(sessions)
		.where(eq(sessions.sourcePath, path))
		.get();
	return row ? { session: toRecord(row), readOffset: row.readOffset } : null;
}

function store(app: App, path: string, read: SourceRead): string[] {
	const { session } = read;
	return app.database.transaction(
		(transaction) => {
			const stored = transaction
				.select({
					lastEventAt: sessions.lastEventAt,
					sourcePath: sessions.sourcePath,
				})
				.from(sessions)
				.where(eq(sessions.id, session.id))
				.get();
			if (stored && stored.sourcePath !== path) {
				throw new Error(
					`${session.id} is already stored from ${stored.sourcePath}`,
				);
			}
			const lastEventAt = newest([
				stored?.lastEventAt ?? session.startedAt,
				...read.events.map((event) => event.at),
			]);
			const transcriptFields = {
				harness: session.harness,
				surface: session.surface,
				parentId: session.parentId,
				title: session.title,
				cwd: session.cwd,
				branch: session.branch,
				startedAt: session.startedAt,
				lastEventAt,
				sourcePath: path,
				readOffset: read.nextOffset,
			};
			transaction
				.insert(sessions)
				.values({
					id: session.id,
					...transcriptFields,
					state: "ended",
					observedAt: lastEventAt,
				})
				.onConflictDoUpdate({ target: sessions.id, set: transcriptFields })
				.run();

			const unmatchedResults: string[] = [];
			for (const event of read.events) {
				if (event.kind === "tool_result") {
					const updated = transaction
						.update(events)
						.set({ toolStatus: event.toolStatus })
						.where(
							and(
								eq(events.sessionId, session.id),
								eq(events.key, event.key),
								eq(events.role, "tool"),
							),
						)
						.returning({ id: events.id })
						.all();
					if (updated.length === 0) {
						unmatchedResults.push(
							`tool result ${event.key} has no stored call, so it was dropped`,
						);
					}
					continue;
				}
				const fields = eventFields(event);
				transaction
					.insert(events)
					.values({
						sessionId: session.id,
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
			return unmatchedResults;
		},
		{ behavior: "immediate" },
	);
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

function toRecord(row: typeof sessions.$inferSelect): SessionRecord {
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

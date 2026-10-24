import type { App } from "@src/app";
import { events, sessions, summaries } from "@src/database";
import { colorize, describeError, formatDuration, pluralize } from "@src/utils";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import {
	type Entry,
	fieldsFromRow,
	parseSummary,
	renderEvent,
	renderInput,
	renderSubagent,
	SUMMARY_SCHEMA,
	type SummaryFields,
	SYSTEM_PROMPT,
} from "./prompt";
import {
	type EventRow,
	newestEventIdBySession,
	type Reader,
	type StoredSummary,
	summariesBySession,
} from "./utils";

export async function refreshSummaries(
	app: App,
	scope: RefreshScope = {},
): Promise<SummaryReport> {
	const plan = app.database.transaction((transaction) =>
		planRefresh(transaction, app.now(), scope.sessionId ?? null),
	);
	const total = plan.levels.flat().length;
	reportPlan(app, plan, total);
	let started = 0;
	const outcomes: Outcome[] = [];
	for (const level of plan.levels) {
		const finished = await mapWithLimit(level, CONCURRENT_CALLS, (due) => {
			started += 1;
			return refreshLogged(app, due, `${started}/${total}`);
		});
		outcomes.push(...finished);
	}
	const calls = outcomes.flatMap((outcome) => outcome.calls);
	const report = {
		roots: tally(
			outcomes.filter((outcome) => outcome.session.parentId === null),
		),
		subagents: tally(
			outcomes.filter((outcome) => outcome.session.parentId !== null),
		),
		deferred: plan.deferred,
		warnings: calls
			.filter((call) => call.largestPromptTokens > PRICE_THRESHOLD_TOKENS)
			.map((call) => ({
				sessionId: call.sessionId,
				message: `chunk ${call.chunk} of ${call.chunks} sent a ${call.largestPromptTokens}-token prompt against an estimate of ${call.estimatedTokens}, over the ${PRICE_THRESHOLD_TOKENS}-token price threshold`,
			})),
		failures: outcomes.flatMap((outcome) => outcome.failure ?? []),
	};
	if (total > 0) {
		reportTotals(app, report);
	}
	return report;
}

function planRefresh(
	database: Reader,
	now: Date,
	sessionId: string | null,
): Plan {
	const rows = sessionRows(database);
	const newestEventIds = newestEventIdBySession(database);
	const stored = summariesBySession(database);
	const childrenByParent = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	const tops = familyTops(rows, sessionId);

	const due: Due[] = [];
	const deferred: string[] = [];
	for (const top of tops) {
		const stale = familyOf(top, childrenByParent, newestEventIds).filter(
			(member) =>
				member.throughEventId >
				(stored.get(member.session.id)?.throughEventId ?? 0),
		);
		if (stale.length === 0) {
			continue;
		}
		const topSummary = stored.get(top.id);
		const isThrottled =
			sessionId === null &&
			topSummary !== undefined &&
			top.state === "busy" &&
			isRecent(topSummary, now);
		if (isThrottled) {
			deferred.push(top.id);
			continue;
		}
		for (const member of stale) {
			const previous = stored.get(member.session.id) ?? null;
			const after = previous?.throughEventId ?? 0;
			due.push({
				...member,
				previous,
				after,
				changedChildren: member.children.filter(
					(child) => child.throughEventId > after,
				),
			});
		}
	}
	const levels = [...Map.groupBy(due, (item) => item.depth)]
		.sort(([left], [right]) => right - left)
		.map(([, items]) => items);
	return { levels, deferred };
}

function reportPlan(app: App, plan: Plan, total: number) {
	if (plan.deferred.length > 0) {
		app.progress(
			"summaries",
			`${colorize("deferred", "blocked")} ${plan.deferred.length} busy ${plan.deferred.length === 1 ? "root" : "roots"} summarized under ${BUSY_REFRESH_MS / 60_000}m ago: ${plan.deferred.join(", ")}`,
		);
		if (total === 0) {
			app.progress("summaries", "nothing else to refresh");
			return;
		}
	}
	if (total === 0) {
		app.progress("summaries", "every summary is current");
		return;
	}
	const subagents = plan.levels
		.flat()
		.filter((due) => due.session.parentId !== null).length;
	app.progress(
		"summaries",
		`${total} to refresh, ${subagents} of them ${subagents === 1 ? "a subagent" : "subagents"}, ${CONCURRENT_CALLS} at a time`,
	);
}

function familyTops(rows: SessionRow[], sessionId: string | null) {
	if (sessionId !== null) {
		return rows.filter((row) => row.id === sessionId);
	}
	return rows
		.filter((row) => row.parentId === null)
		.sort((left, right) => +right.lastEventAt - +left.lastEventAt);
}

function familyOf(
	root: SessionRow,
	childrenByParent: Map<string | null, SessionRow[]>,
	newestEventIds: Map<string, number>,
): Member[] {
	const members: Member[] = [];
	function visit(session: SessionRow, depth: number): Member {
		const children = (childrenByParent.get(session.id) ?? []).map((child) =>
			visit(child, depth + 1),
		);
		const member = {
			session,
			depth,
			children,
			throughEventId: Math.max(
				newestEventIds.get(session.id) ?? 0,
				...children.map((child) => child.throughEventId),
			),
			lastActiveAt: new Date(
				Math.max(
					+session.lastEventAt,
					...children.map((child) => +child.lastActiveAt),
				),
			),
		};
		members.push(member);
		return member;
	}
	visit(root, 0);
	return members;
}

function isRecent(summary: StoredSummary, now: Date): boolean {
	return +now - +summary.updatedAt < BUSY_REFRESH_MS;
}

async function mapWithLimit<Item, Result>(
	items: Item[],
	limit: number,
	work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
	const results: Result[] = [];
	const queue = items.entries();
	async function worker() {
		for (const [index, item] of queue) {
			results[index] = await work(item);
		}
	}
	await Promise.all(Array.from({ length: limit }, worker));
	return results;
}

async function refreshLogged(
	app: App,
	due: Due,
	position: string,
): Promise<Outcome> {
	const name = describeSession(due.session);
	app.progress("summaries", `started ${position} ${name}`);
	const startedAt = app.now();
	const outcome = await refresh(app, due);
	const took = formatDuration(startedAt, app.now());
	if (outcome.failure) {
		app.progress(
			"summaries",
			`${colorize("failed", "error")} ${position} ${name} after ${took}: ${outcome.failure.message}`,
		);
	} else {
		app.progress(
			"summaries",
			`${colorize("done", "finished")} ${position} ${name} in ${took}, ${pluralize(outcome.calls.length, "call")}`,
		);
	}
	return outcome;
}

function describeSession(session: SessionRow): string {
	if (!session.title) {
		return session.id;
	}
	const title = session.title.replace(/\s+/g, " ").trim();
	if (title.length <= MAX_TITLE_CHARS) {
		return `${session.id} · ${title}`;
	}
	return `${session.id} · ${title.slice(0, MAX_TITLE_CHARS)}…`;
}

async function refresh(app: App, due: Due): Promise<Outcome> {
	const calls: Call[] = [];
	try {
		const work = loadWork(app.database, due);
		storeSummary(app, due, await summarize(app, work, calls));
		return { session: due.session, calls, failure: null };
	} catch (error) {
		return {
			session: due.session,
			calls,
			failure: { sessionId: due.session.id, message: describeError(error) },
		};
	}
}

function loadWork(database: Reader, due: Due): Work {
	const own = eventsBetween(
		database,
		due.session.id,
		due.after,
		due.throughEventId,
	).map(renderEvent);
	const subagents = due.changedChildren.map((child) =>
		subagentEntry(database, child),
	);
	return {
		session: due.session,
		previous: due.previous ? fieldsFromRow(due.previous) : null,
		entries: [...own, ...subagents].sort(
			(left, right) => +left.at - +right.at || left.id - right.id,
		),
	};
}

function subagentEntry(database: Reader, child: Member): Entry {
	const summary = summaryOf(database, child.session.id);
	if (!summary || summary.throughEventId < child.throughEventId) {
		throw new Error(
			`waits for subagent ${child.session.id}, whose summary is behind`,
		);
	}
	return renderSubagent(child, summary);
}

async function summarize(
	app: App,
	work: Work,
	calls: Call[],
): Promise<SummaryFields> {
	const chunks = splitIntoChunks(work.entries);
	let summary = work.previous;
	for (const [index, chunk] of chunks.entries()) {
		const input = renderInput(work.session, summary, chunk);
		const response = await app.askClaude({
			model: MODEL,
			systemPrompt: SYSTEM_PROMPT,
			input,
			schema: SUMMARY_SCHEMA,
		});
		calls.push({
			sessionId: work.session.id,
			chunk: index + 1,
			chunks: chunks.length,
			estimatedTokens: estimateTokens(SYSTEM_PROMPT) + estimateTokens(input),
			inputTokens: response.inputTokens,
			largestPromptTokens: response.largestPromptTokens,
		});
		summary = parseSummary(response.output);
	}
	if (!summary) {
		throw new Error("there was nothing to summarize");
	}
	return summary;
}

function splitIntoChunks(entries: Entry[]): Entry[][] {
	const chunks: Entry[][] = [];
	let current: Entry[] = [];
	let size = 0;
	for (const entry of entries) {
		const tokens = estimateTokens(entry.text) + 1;
		if (current.length > 0 && size + tokens > CHUNK_TOKENS) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(entry);
		size += tokens;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN);
}

function storeSummary(app: App, due: Due, fields: SummaryFields) {
	const row = {
		sessionId: due.session.id,
		throughEventId: due.throughEventId,
		objective: fields.objective,
		progress: fields.progress.join("\n"),
		tried: fields.tried.join("\n"),
		next: fields.next.join("\n"),
		blockers: fields.blockers.join("\n"),
		waitingOn: fields.waitingOn,
		ask: fields.ask,
		outcome: fields.outcome,
		updatedAt: app.now(),
	};
	app.database
		.insert(summaries)
		.values(row)
		.onConflictDoUpdate({
			target: summaries.sessionId,
			set: row,
			setWhere: sql`${summaries.throughEventId} <= excluded.through_event_id`,
		})
		.run();
}

function reportTotals(app: App, report: SummaryReport) {
	const refreshed = report.roots.refreshed + report.subagents.refreshed;
	const calls = report.roots.calls + report.subagents.calls;
	const tokens = report.roots.inputTokens + report.subagents.inputTokens;
	const parts = [`${refreshed} refreshed`];
	if (report.failures.length > 0) {
		parts.push(colorize(`${report.failures.length} failed`, "error"));
	}
	if (report.warnings.length > 0) {
		parts.push(
			colorize(`${report.warnings.length} over the price tier`, "blocked"),
		);
	}
	parts.push(
		`${calls} Haiku ${calls === 1 ? "call" : "calls"}`,
		`${tokens.toLocaleString("en-US")} input tokens`,
	);
	app.progress("summaries", parts.join(" · "));
}

function tally(outcomes: Outcome[]): SummaryTally {
	const calls = outcomes.flatMap((outcome) => outcome.calls);
	return {
		refreshed: outcomes.filter((outcome) => outcome.failure === null).length,
		calls: calls.length,
		inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
	};
}

function sessionRows(database: Reader): SessionRow[] {
	return database
		.select({
			id: sessions.id,
			parentId: sessions.parentId,
			title: sessions.title,
			cwd: sessions.cwd,
			state: sessions.state,
			lastEventAt: sessions.lastEventAt,
		})
		.from(sessions)
		.all();
}

function eventsBetween(
	database: Reader,
	sessionId: string,
	afterId: number,
	throughId: number,
): EventRow[] {
	return database
		.select()
		.from(events)
		.where(
			and(
				eq(events.sessionId, sessionId),
				gt(events.id, afterId),
				lte(events.id, throughId),
			),
		)
		.orderBy(asc(events.at), asc(events.id))
		.all();
}

function summaryOf(
	database: Reader,
	sessionId: string,
): StoredSummary | undefined {
	return database
		.select()
		.from(summaries)
		.where(eq(summaries.sessionId, sessionId))
		.get();
}

export type SummaryReport = {
	roots: SummaryTally;
	subagents: SummaryTally;
	deferred: string[];
	warnings: SummaryIssue[];
	failures: SummaryIssue[];
};

export type SummaryTally = {
	refreshed: number;
	calls: number;
	inputTokens: number;
};

export type SummaryIssue = { sessionId: string; message: string };

export type RefreshScope = { sessionId?: string };

type Plan = { levels: Due[][]; deferred: string[] };

type Member = {
	session: SessionRow;
	depth: number;
	throughEventId: number;
	lastActiveAt: Date;
	children: Member[];
};

type Due = Member & {
	previous: StoredSummary | null;
	after: number;
	changedChildren: Member[];
};

type Outcome = {
	session: SessionRow;
	calls: Call[];
	failure: SummaryIssue | null;
};

type Call = {
	sessionId: string;
	chunk: number;
	chunks: number;
	estimatedTokens: number;
	inputTokens: number;
	largestPromptTokens: number;
};

type Work = {
	session: SessionRow;
	previous: SummaryFields | null;
	entries: Entry[];
};

type SessionRow = {
	id: string;
	parentId: string | null;
	title: string | null;
	cwd: string;
	state: (typeof sessions.$inferSelect)["state"];
	lastEventAt: Date;
};

const MODEL = "claude-haiku-5-5";

const CONCURRENT_CALLS = 10;

const BUSY_REFRESH_MS = 15 * 60_000;

// fact: Haiku 5.5 input costs 5x more once a prompt crosses 100,000 tokens (pricing page, 2026-10-23).
const PRICE_THRESHOLD_TOKENS = 100_000;

const CHUNK_TOKENS = 85_000;

// fact: mostly-ASCII transcripts measured 2.2 (real, path- and command-heavy) to 3.2 (prose) characters per Haiku 5.5 token on 2026-10-23.
const BYTES_PER_TOKEN = 2;

const MAX_TITLE_CHARS = 60;

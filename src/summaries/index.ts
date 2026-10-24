import type { App } from "@src/app";
import {
	events,
	type StatusDatabase,
	sessions,
	summaries,
} from "@src/database";
import { and, asc, eq, gt, lte, max, sql } from "drizzle-orm";

export async function refreshSummaries(app: App): Promise<SummaryReport> {
	const plan = app.database.transaction((transaction) =>
		planRefresh(transaction, app.now()),
	);
	const total = plan.levels.flat().length;
	let started = 0;
	const outcomes: Outcome[] = [];
	for (const level of plan.levels) {
		const finished = await mapWithLimit(level, CONCURRENT_CALLS, (due) => {
			started += 1;
			app.progress(`summarizing ${started}/${total}`);
			return refresh(app, due);
		});
		outcomes.push(...finished);
	}
	const calls = outcomes.flatMap((outcome) => outcome.calls);
	return {
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
}

function planRefresh(database: Reader, now: Date): Plan {
	const rows = sessionRows(database);
	const newestEventIds = newestEventIdBySession(database);
	const stored = summariesBySession(database);
	const childrenByParent = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	const roots = rows
		.filter((row) => row.parentId === null)
		.sort((left, right) => +right.lastEventAt - +left.lastEventAt);

	const due: Due[] = [];
	const deferred: string[] = [];
	for (const root of roots) {
		const stale = familyOf(root, childrenByParent, newestEventIds).filter(
			(member) =>
				member.throughEventId >
				(stored.get(member.session.id)?.throughEventId ?? 0),
		);
		if (stale.length === 0) {
			continue;
		}
		const rootSummary = stored.get(root.id);
		if (rootSummary && root.state === "busy" && isRecent(rootSummary, now)) {
			deferred.push(root.id);
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

async function refresh(app: App, due: Due): Promise<Outcome> {
	const calls: Call[] = [];
	try {
		const work = loadWork(app.database, due);
		storeSummary(app, due, await summarize(app, work, calls));
		return { session: due.session, calls, failure: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			session: due.session,
			calls,
			failure: { sessionId: due.session.id, message },
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
		renderSubagent(database, child),
	);
	return {
		session: due.session,
		previous: due.previous ? fieldsFromRow(due.previous) : null,
		firstUserMessage: firstUserMessage(database, due.session.id),
		entries: [...own, ...subagents].sort(
			(left, right) => +left.at - +right.at || left.id - right.id,
		),
	};
}

function renderEvent(row: EventRow): Entry {
	const time = formatTime(row.at);
	if (row.role === "tool") {
		const status = row.toolStatus ?? "pending";
		return {
			id: row.id,
			at: row.at,
			text: `[${time} tool, ${status}] ${toolHeadline(row)}`,
		};
	}
	return {
		id: row.id,
		at: row.at,
		text: `[${time} ${row.role}]\n${cutMiddle(row.text)}`,
	};
}

function formatTime(at: Date): string {
	return at.toISOString().slice(0, 16).replace("T", " ");
}

function toolHeadline(row: EventRow): string {
	const target = row.toolTarget?.replaceAll("\n", ", ");
	const headline = target ? `${row.toolName ?? ""} ${target}` : row.text;
	const line = headline.replace(/\s+/g, " ").trim();
	if (line.length <= MAX_TOOL_CHARS) {
		return line;
	}
	return `${line.slice(0, MAX_TOOL_CHARS)}…`;
}

function cutMiddle(text: string): string {
	if (text.length <= MAX_MESSAGE_CHARS) {
		return text;
	}
	const half = MAX_MESSAGE_CHARS / 2;
	const omitted = text.length - MAX_MESSAGE_CHARS;
	return `${text.slice(0, half)}\n[… ${omitted} characters cut …]\n${text.slice(-half)}`;
}

function renderSubagent(database: Reader, child: Member): Entry {
	const summary = summaryOf(database, child.session.id);
	if (!summary || summary.throughEventId < child.throughEventId) {
		throw new Error(
			`waits for subagent ${child.session.id}, whose summary is behind`,
		);
	}
	const at = child.lastActiveAt;
	return {
		id: child.throughEventId,
		at,
		text: `[${formatTime(at)} subagent ${child.session.id}'s summary]\n${renderSummary(fieldsFromRow(summary))}`,
	};
}

function renderSummary(summary: SummaryFields): string {
	const list = (items: string[]) =>
		items.length > 0 ? items.map((item) => `\n- ${item}`).join("") : " none";
	return [
		`objective: ${summary.objective}`,
		`progress:${list(summary.progress)}`,
		`tried:${list(summary.tried)}`,
		`next:${list(summary.next)}`,
		`blockers:${list(summary.blockers)}`,
		`waiting_on: ${summary.waitingOn}`,
		`ask: ${summary.ask ?? "null"}`,
		`outcome: ${summary.outcome}`,
	].join("\n");
}

function fieldsFromRow(row: StoredSummary): SummaryFields {
	const list = (text: string) => text.split("\n").filter((item) => item !== "");
	return {
		objective: row.objective,
		progress: list(row.progress),
		tried: list(row.tried),
		next: list(row.next),
		blockers: list(row.blockers),
		waitingOn: row.waitingOn,
		ask: row.ask,
		outcome: row.outcome,
	};
}

async function summarize(
	app: App,
	work: Work,
	calls: Call[],
): Promise<SummaryFields> {
	const chunks = splitIntoChunks(work.entries);
	let summary = work.previous;
	for (const [index, chunk] of chunks.entries()) {
		const input = renderInput(work, summary, chunk);
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

function renderInput(
	work: Work,
	summary: SummaryFields | null,
	chunk: Entry[],
): string {
	let header = `Session: ${work.session.title ?? "untitled"}\nWorking directory: ${work.session.cwd}`;
	if (work.session.parentId) {
		header += `\nSubagent of: ${work.session.parentId}`;
	}
	const entries = chunk.map((entry) => entry.text).join("\n\n");
	if (!summary) {
		return `${header}\n\n## Entries\n\n${entries}`;
	}
	const sections = [header, `## Summary so far\n\n${renderSummary(summary)}`];
	if (work.firstUserMessage) {
		sections.push(
			`## First user message\n\n${cutMiddle(work.firstUserMessage)}`,
		);
	}
	sections.push(`## New entries\n\n${entries}`);
	return sections.join("\n\n");
}

function parseSummary(output: unknown): SummaryFields {
	const value = (output ?? {}) as Record<string, unknown>;
	const field = (name: string) => value[name];
	const waitingOn = requireChoice(
		field("waiting_on"),
		WAITING_ON,
		"waiting_on",
	);
	const ask = optionalText(field("ask"), "ask");
	const outcome = requireChoice(field("outcome"), OUTCOMES, "outcome");
	if (waitingOn === "user" && ask === null) {
		throw new Error("Haiku returned waiting_on user without an ask");
	}
	if (waitingOn !== "user" && ask !== null) {
		throw new Error(`Haiku returned an ask while waiting_on is ${waitingOn}`);
	}
	if (outcome === "done" && waitingOn !== "none") {
		throw new Error(
			`Haiku returned outcome done while waiting_on is ${waitingOn}`,
		);
	}
	return {
		objective: requireText(field("objective"), "objective"),
		progress: requireList(field("progress"), "progress"),
		tried: requireList(field("tried"), "tried"),
		next: requireList(field("next"), "next"),
		blockers: requireList(field("blockers"), "blockers"),
		waitingOn,
		ask,
		outcome,
	};
}

function requireChoice<Choice extends string>(
	value: unknown,
	choices: readonly Choice[],
	name: string,
): Choice {
	if (!choices.includes(value as Choice)) {
		throw new Error(
			`Haiku returned ${JSON.stringify(value)} for ${name}, not one of ${choices.join(", ")}`,
		);
	}
	return value as Choice;
}

function optionalText(value: unknown, name: string): string | null {
	if (value === null || (typeof value === "string" && value.trim() === "")) {
		return null;
	}
	return requireText(value, name);
}

function requireText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Haiku returned a summary without ${name}`);
	}
	return value.trim();
}

function requireList(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Haiku returned a summary whose ${name} isn't a list`);
	}
	return value
		.map((item: string) => item.replace(/\s+/g, " ").trim())
		.filter((item) => item !== "");
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

export function newestEventIdBySession(database: Reader): Map<string, number> {
	const rows = database
		.select({ sessionId: events.sessionId, newest: max(events.id) })
		.from(events)
		.groupBy(events.sessionId)
		.all();
	return new Map(rows.map((row) => [row.sessionId, row.newest ?? 0]));
}

export function summariesBySession(
	database: Reader,
): Map<string, StoredSummary> {
	const rows = database.select().from(summaries).all();
	return new Map(rows.map((row) => [row.sessionId, row]));
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

function firstUserMessage(database: Reader, sessionId: string): string | null {
	const row = database
		.select({ text: events.text })
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.role, "user")))
		.orderBy(asc(events.at), asc(events.id))
		.limit(1)
		.get();
	return row?.text ?? null;
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
	firstUserMessage: string | null;
	entries: Entry[];
};

type Entry = { id: number; at: Date; text: string };

type SummaryFields = {
	objective: string;
	progress: string[];
	tried: string[];
	next: string[];
	blockers: string[];
	waitingOn: StoredSummary["waitingOn"];
	ask: string | null;
	outcome: StoredSummary["outcome"];
};

type Reader = Pick<StatusDatabase, "select">;

type SessionRow = {
	id: string;
	parentId: string | null;
	title: string | null;
	cwd: string;
	state: (typeof sessions.$inferSelect)["state"];
	lastEventAt: Date;
};

type EventRow = typeof events.$inferSelect;

type StoredSummary = typeof summaries.$inferSelect;

const MODEL = "claude-haiku-5-5";

const CONCURRENT_CALLS = 4;

const BUSY_REFRESH_MS = 15 * 60_000;

// fact: Haiku 5.5 input costs 5x more once a prompt crosses 100,000 tokens (pricing page, 2026-10-23).
const PRICE_THRESHOLD_TOKENS = 100_000;

const CHUNK_TOKENS = 85_000;

// fact: mostly-ASCII transcripts measured 2.2 (real, path- and command-heavy) to 3.2 (prose) characters per Haiku 5.5 token on 2026-10-23.
const BYTES_PER_TOKEN = 2;

const MAX_MESSAGE_CHARS = 16_000;

const MAX_TOOL_CHARS = 300;

const WAITING_ON = ["user", "external", "none"] as const;

const OUTCOMES = ["in_progress", "done", "abandoned"] as const;

const SYSTEM_PROMPT = `You keep a rolling summary of one AI coding-agent session (Claude Code or Codex). Two kinds of readers act on it without opening the transcript:
- Other coding agents read it before they start work, so they don't redo or collide with this session. They need exact file paths, commands, branch names, commit hashes and error messages, and what already failed.
- The user reads it in a morning triage across many sessions, to see what finished, what is still running and what is waiting on them.

Input
- A header names the session and its working directory. A "Subagent of" line means this session is itself a subagent (see Subagent sessions below).
- Entries in time order. User and assistant messages are in full; very long ones are cut in the middle. Tool calls are one-line headlines with the tool's name, its target (file, command, URL or pattern) and its outcome: ok; error; user_denied (a person rejected the call, so the user has already said no); auto_denied (an automatic reviewer refused it and no human decided); or pending (no result recorded yet). Tool output is not included, so infer results from what the assistant said next.
- Subagents are helper agents the session launched. Each one appears as its own summary, in these same fields, at the time it was last active. Their findings and dead ends count as this session's own: carry what matters into progress and tried with the subagent's exact names and errors. A subagent's suggestion is a next step only once this session takes it up. A subagent waiting on the user means this session waits on the user too.
- When a "Summary so far" is given, the entries are only what happened after it. Return the whole updated summary: keep what is still true, add what the new entries show, and rewrite or drop what they made obsolete (a fixed blocker, an answered question, a step now done). Carry progress and tried items forward, merging related ones to stay within the limits; never drop a tried item just because the new entries don't mention it. The first user message is repeated so the objective stays anchored.

Fields
Write plain text, one sentence per list item. Use exact names, never vague ones. Never invent what the entries don't show.
- objective: the user's goal in one or two sentences, from the first user message and any later change of direction. Only the goal: no status, no working directory.
- progress: what is done, most important first: changes made and the files they touched, checks that passed with their command, commits with hash and message, PRs, decisions taken. Only what was actually done, not what was planned. If the last tool calls are still pending, say what was started and that it has no result yet. At most 8 items.
- tried: approaches that failed or were dropped, each with why: the error, the failing command, the reason the user rejected it, what a subagent looked for and didn't find, a user_denied call with the user's reason when given, an auto_denied call the session worked around. Not open problems (those are blockers), not problems since solved (those are progress, with the fix), and not trivia that teaches nothing, such as a typo fixed on the next try or a network error a retry got past. At most 8 items. Empty if nothing failed.
- next: the remaining steps toward the objective that the session itself stated or committed to. Never add steps of your own, such as a review, an extra check or a wider test run, and drop steps the new entries show done or dropped. An offer or proposal still waiting on the user's answer is the ask, not a step. Empty when nothing remains.
- blockers: what stops progress right now: an unanswered question, an auto_denied call the session stalled on (it may need the user's manual approval or another approach), an error the session couldn't get past, something external. A dead end the session routed around belongs in tried, not here. Empty if nothing.
- waiting_on: user when the session stopped for the user: an unanswered question or choice, an offer or proposal of more work, an approval, a permission, something only the user can do; external when it waits on something outside the session (CI, a review, a deploy, another team); none when it is still working, done or abandoned.
- ask: when waiting_on is user, the exact question or decision, self-contained: what is being decided, the options the session offered and its recommendation, and the context needed to answer without the transcript. When the session ended by offering or proposing more work, the ask is that offer as a question the user can answer yes or no, such as "Push the branch and open a PR?". Never ask the user to approve a call they already denied. Otherwise null.
- outcome: done only when nothing is left: the session's latest report says the work is finished and it proposes nothing further. A session that ends offering or proposing more work, such as pushing, opening a PR or a further fix, is not done: it is in_progress and waiting on the user, with the offer as the ask. abandoned when the user or the session gave up or moved on without finishing. in_progress otherwise, including while waiting on the user or on something external.

Subagent sessions
A subagent was given its task by another agent, and its report goes back to that agent, not to the user. Its user messages are that agent's instructions. Apply the fields as above, except:
- objective: the task it was given. A Claude workflow agent gets the user's shared request and then its own computed task: the objective is the computed task. A Codex subagent's task is encrypted apart from its header: infer the objective from the task name and what the subagent did, and state it as the task, without saying how it was inferred.
- An offer or suggestion in its report is for the agent that launched it, not an ask: the subagent is done when its report says the task is finished. A SubagentHandback call is that report going back, and the subagent stops after it.
- waiting_on is user only when a person must act, such as approving a permission it stopped on.`;

const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		objective: { type: "string" },
		progress: { type: "array", items: { type: "string" } },
		tried: { type: "array", items: { type: "string" } },
		next: { type: "array", items: { type: "string" } },
		blockers: { type: "array", items: { type: "string" } },
		waiting_on: { type: "string", enum: WAITING_ON },
		ask: { type: ["string", "null"] },
		outcome: { type: "string", enum: OUTCOMES },
	},
	required: [
		"objective",
		"progress",
		"tried",
		"next",
		"blockers",
		"waiting_on",
		"ask",
		"outcome",
	],
	additionalProperties: false,
	allOf: [
		{
			if: { properties: { waiting_on: { const: "user" } } },
			// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, never awaited
			then: { properties: { ask: { type: "string", pattern: "\\S" } } },
			else: { properties: { ask: { type: "null" } } },
		},
		{
			if: { properties: { outcome: { const: "done" } } },
			// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, never awaited
			then: { properties: { waiting_on: { const: "none" } } },
		},
	],
};

import type { App } from "@src/app";
import {
	events,
	type StatusDatabase,
	sessions,
	summaries,
} from "@src/database";
import { and, asc, desc, eq, gt, lt, max, sql } from "drizzle-orm";

/** @public */
export type SummaryReport = {
	refreshed: number;
	deferred: string[];
	calls: number;
	inputTokens: number;
	warnings: SummaryIssue[];
	failures: SummaryIssue[];
};

/** @public */
export type SummaryIssue = { sessionId: string; message: string };

/** @public */
export async function refreshSummaries(app: App): Promise<SummaryReport> {
	const plan = app.database.transaction((transaction) =>
		planRefresh(transaction, app.now()),
	);
	let started = 0;
	const outcomes = await mapWithLimit(plan.due, CONCURRENT_CALLS, (work) => {
		started += 1;
		app.progress(`summarizing ${started}/${plan.due.length}`);
		return refresh(app, work);
	});
	const calls = outcomes.flatMap((outcome) => outcome.calls);
	return {
		refreshed: outcomes.filter((outcome) => outcome.failure === null).length,
		deferred: plan.deferred,
		calls: calls.length,
		inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
		warnings: calls
			.filter((call) => call.largestPromptTokens > PRICE_THRESHOLD_TOKENS)
			.map((call) => ({
				sessionId: call.sessionId,
				message: `chunk ${call.chunk} of ${call.chunks} sent a ${call.largestPromptTokens}-token prompt against an estimate of ${call.estimatedTokens}, over the ${PRICE_THRESHOLD_TOKENS}-token price threshold`,
			})),
		failures: outcomes.flatMap((outcome) => outcome.failure ?? []),
	};
}

async function refresh(app: App, work: Work): Promise<Outcome> {
	const calls: Call[] = [];
	try {
		if (work.entries.length === 0) {
			advanceSummary(app, work);
		} else {
			storeSummary(app, work, await summarize(app, work, calls));
		}
		return { calls, failure: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { calls, failure: { sessionId: work.root.id, message } };
	}
}

function planRefresh(
	database: Reader,
	now: Date,
): { due: Work[]; deferred: string[] } {
	const rows = database
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
	const newestEventIds = new Map(
		database
			.select({ sessionId: events.sessionId, newest: max(events.id) })
			.from(events)
			.groupBy(events.sessionId)
			.all()
			.map((row) => [row.sessionId, row.newest ?? 0]),
	);
	const stored = new Map(
		database
			.select()
			.from(summaries)
			.all()
			.map((row) => [row.sessionId, row]),
	);
	const childrenByParent = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	const roots = rows
		.filter((row) => row.parentId === null)
		.sort((left, right) => +right.lastEventAt - +left.lastEventAt);

	const due: Work[] = [];
	const deferred: string[] = [];
	for (const root of roots) {
		const subagents = descendantsOf(root.id, childrenByParent);
		const throughEventId = Math.max(
			...[root, ...subagents].map((row) => newestEventIds.get(row.id) ?? 0),
		);
		const previous = stored.get(root.id) ?? null;
		const after = previous?.throughEventId ?? 0;
		if (throughEventId <= after) {
			continue;
		}
		if (previous && root.state === "busy" && isRecent(previous, now)) {
			deferred.push(root.id);
			continue;
		}
		const changedSubagents = subagents.filter(
			(subagent) => (newestEventIds.get(subagent.id) ?? 0) > after,
		);
		const work = loadWork(
			database,
			root,
			changedSubagents,
			previous,
			throughEventId,
		);
		if (work.entries.length > 0 || previous) {
			due.push(work);
		}
	}
	return { due, deferred };
}

function descendantsOf(
	rootId: string,
	childrenByParent: Map<string | null, SessionRow[]>,
): SessionRow[] {
	const found: SessionRow[] = [];
	const seen = new Set([rootId]);
	const queue = [rootId];
	for (const parentId of queue) {
		for (const child of childrenByParent.get(parentId) ?? []) {
			if (!seen.has(child.id)) {
				seen.add(child.id);
				found.push(child);
				queue.push(child.id);
			}
		}
	}
	return found;
}

function isRecent(summary: StoredSummary, now: Date): boolean {
	return +now - +summary.updatedAt < BUSY_REFRESH_MS;
}

function loadWork(
	database: Reader,
	root: SessionRow,
	subagents: SessionRow[],
	previous: StoredSummary | null,
	throughEventId: number,
): Work {
	const after = previous?.throughEventId ?? 0;
	const rootEntries = database
		.select()
		.from(events)
		.where(and(eq(events.sessionId, root.id), gt(events.id, after)))
		.orderBy(asc(events.at), asc(events.id))
		.all()
		.map(renderEvent);
	const subagentEntries = subagents.flatMap((subagent) =>
		renderSubagent(database, subagent, after),
	);
	const entries = [...rootEntries, ...subagentEntries].sort(
		(left, right) => +left.at - +right.at || left.id - right.id,
	);
	const firstUserMessage = database
		.select({ text: events.text })
		.from(events)
		.where(and(eq(events.sessionId, root.id), eq(events.role, "user")))
		.orderBy(asc(events.at), asc(events.id))
		.limit(1)
		.get();
	return {
		root,
		previous: previous ? fieldsFromRow(previous) : null,
		firstUserMessage: firstUserMessage?.text ?? null,
		entries,
		throughEventId,
	};
}

function renderEvent(row: typeof events.$inferSelect): Entry {
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

function toolHeadline(row: typeof events.$inferSelect): string {
	const target = row.toolTarget?.replaceAll("\n", ", ");
	const headline = target ? `${row.toolName ?? ""} ${target}` : row.text;
	const line = headline.replace(/\s+/g, " ").trim();
	if (line.length <= MAX_TOOL_CHARS) {
		return line;
	}
	return `${line.slice(0, MAX_TOOL_CHARS)}…`;
}

function renderSubagent(
	database: Reader,
	subagent: SessionRow,
	after: number,
): Entry[] {
	const entries: Entry[] = [];
	const task = taskOf(database, subagent.id);
	if (task && task.id > after) {
		entries.push({
			id: task.id,
			at: task.at,
			text: `[${formatTime(task.at)} subagent ${subagent.id} started] ${describeTask(task.text)}`,
		});
	}
	const report = latestEvent(database, subagent.id, "assistant");
	if (report && report.id > after) {
		const finished = latestEvent(database, subagent.id)?.id === report.id;
		const status = finished ? "finished" : "unfinished, latest message";
		entries.push({
			id: report.id,
			at: report.at,
			text: `[${formatTime(report.at)} subagent ${subagent.id} ${status}]\n${cutMiddle(report.text)}`,
		});
	}
	return entries;
}

function taskOf(database: Reader, sessionId: string) {
	const opening = database
		.select({
			id: events.id,
			at: events.at,
			role: events.role,
			text: events.text,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(asc(events.at), asc(events.id))
		.limit(OPENING_EVENTS)
		.all();
	const firstReply = opening.findIndex((row) => row.role !== "user");
	const prompts = firstReply === -1 ? opening : opening.slice(0, firstReply);
	return prompts.at(-1);
}

function describeTask(text: string): string {
	const readable = text.replace(ENCRYPTED_PAYLOAD, "").trim();
	if (readable === text.trim()) {
		return `task:\n${cutMiddle(text)}`;
	}
	return `task, encrypted apart from its header:\n${readable}`;
}

function latestEvent(database: Reader, sessionId: string, role?: "assistant") {
	const ofRole = role ? eq(events.role, role) : undefined;
	return database
		.select({ id: events.id, at: events.at, text: events.text })
		.from(events)
		.where(and(eq(events.sessionId, sessionId), ofRole))
		.orderBy(desc(events.at), desc(events.id))
		.limit(1)
		.get();
}

function formatTime(at: Date): string {
	return at.toISOString().slice(0, 16).replace("T", " ");
}

function cutMiddle(text: string): string {
	if (text.length <= MAX_MESSAGE_CHARS) {
		return text;
	}
	const half = MAX_MESSAGE_CHARS / 2;
	const omitted = text.length - MAX_MESSAGE_CHARS;
	return `${text.slice(0, half)}\n[… ${omitted} characters cut …]\n${text.slice(-half)}`;
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
			sessionId: work.root.id,
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
	const header = `Session: ${work.root.title ?? "untitled"}\nWorking directory: ${work.root.cwd}`;
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
		`ask: ${summary.ask ?? "none"}`,
		`outcome: ${summary.outcome}`,
	].join("\n");
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
	return {
		objective: requireText(field("objective"), "objective"),
		progress: requireList(field("progress"), "progress"),
		tried: requireList(field("tried"), "tried"),
		next: requireList(field("next"), "next"),
		blockers: requireList(field("blockers"), "blockers"),
		waitingOn,
		ask: waitingOn === "user" ? ask : null,
		outcome: requireChoice(field("outcome"), OUTCOMES, "outcome"),
	};
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

function advanceSummary(app: App, work: Work) {
	app.database
		.update(summaries)
		.set({ throughEventId: work.throughEventId })
		.where(
			and(
				eq(summaries.sessionId, work.root.id),
				lt(summaries.throughEventId, work.throughEventId),
			),
		)
		.run();
}

function storeSummary(app: App, work: Work, fields: SummaryFields) {
	const row = {
		sessionId: work.root.id,
		throughEventId: work.throughEventId,
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

type Outcome = { calls: Call[]; failure: SummaryIssue | null };

type Call = {
	sessionId: string;
	chunk: number;
	chunks: number;
	estimatedTokens: number;
	inputTokens: number;
	largestPromptTokens: number;
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

type StoredSummary = typeof summaries.$inferSelect;

type Work = {
	root: SessionRow;
	previous: SummaryFields | null;
	firstUserMessage: string | null;
	entries: Entry[];
	throughEventId: number;
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

const OPENING_EVENTS = 8;

// fact: a Codex subagent's task arrives encrypted, and the Codex adapter keeps only its plaintext header, ending in this marker.
const ENCRYPTED_PAYLOAD = /(?:\n\s*Payload:)?\s*\[encrypted payload\]\s*$/;

const WAITING_ON = ["user", "external", "none"] as const;

const OUTCOMES = ["in_progress", "done", "abandoned"] as const;

const SYSTEM_PROMPT = `You keep a rolling summary of one AI coding-agent session (Claude Code or Codex). Two kinds of readers act on it without opening the transcript:
- Other coding agents read it before they start work, so they don't redo or collide with this session. They need exact file paths, commands, branch names, commit hashes and error messages, and what already failed.
- The user reads it in a morning triage across many sessions, to see what finished, what is still running and what is waiting on them.

Input
- Entries in time order. User and assistant messages are in full; very long ones are cut in the middle. Tool calls are one-line headlines with the tool's name, its target (file, command, URL or pattern) and its outcome: ok; error; user_denied (a person rejected the call, so the user has already said no); auto_denied (an automatic reviewer refused it and no human decided); or pending (no result recorded yet). Tool output is not included, so infer results from what the assistant said next.
- Subagents are helper agents the session launched. Each one's task appears where it started (a Codex subagent's task is encrypted apart from its header), and its latest message where it was written, marked finished or unfinished. Their findings and dead ends count as this session's own.
- When a "Summary so far" is given, the entries are only what happened after it. Return the whole updated summary: keep what is still true, add what the new entries show, and rewrite or drop what they made obsolete (a fixed blocker, an answered question, a step now done). Carry progress and tried items forward, merging related ones to stay within the limits; never drop a tried item just because the new entries don't mention it. The first user message is repeated so the objective stays anchored.

Fields
Write plain text, one sentence per list item. Use exact names, never vague ones. Never invent what the entries don't show.
- objective: the user's goal in one or two sentences, from the first user message and any later change of direction. Only the goal: no status, no working directory.
- progress: what is done, most important first: changes made and the files they touched, checks that passed with their command, commits with hash and message, PRs, decisions taken. Only what was actually done, not what was planned. If the last tool calls are still pending, say what was started and that it has no result yet. At most 8 items.
- tried: approaches that failed or were dropped, each with why: the error, the failing command, the reason the user rejected it, what a subagent looked for and didn't find, a user_denied call with the user's reason when given, an auto_denied call the session worked around. Not open problems (those are blockers), not problems since solved (those are progress, with the fix), and not trivia that teaches nothing, such as a typo fixed on the next try or a network error a retry got past. At most 8 items. Empty if nothing failed.
- next: the remaining steps toward the objective that the session itself stated or committed to. Never add steps of your own, such as a review, an extra check or a wider test run, and drop steps the new entries show done or dropped. A follow-up the session offered after meeting the objective goes here as "Offered: ...". Empty when nothing remains.
- blockers: what stops progress right now: an unanswered question, an auto_denied call the session stalled on (it may need the user's manual approval or another approach), an error the session couldn't get past, something external. A dead end the session routed around belongs in tried, not here. Empty if nothing.
- waiting_on: user when the session can't continue without the user (an unanswered question or choice, an approval, a permission, something only the user can do); external when it waits on something outside the session (CI, a review, a deploy, another team); none when it is working, or finished.
- ask: when waiting_on is user, the exact question or decision, self-contained: what is being decided, the options the session offered and its recommendation, and the context needed to answer without the transcript. Never ask the user to approve a call they already denied. Otherwise null.
- outcome: done when the session's latest report says the objective is met (the change made and checked, committed, the question answered), even if it offers extras such as pushing, opening a PR or further fixes: an optional offer is not an ask, and doesn't keep the session in progress. abandoned when the user or the session gave up or moved on without finishing. in_progress otherwise, including while waiting on the user.`;

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
};

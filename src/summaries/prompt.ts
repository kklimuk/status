import type { EventRow, StoredSummary } from "./utils";

export function renderEvent(row: EventRow): Entry {
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
		text: `[${time} ${row.role}]\n${row.text}`,
	};
}

export function renderSubagent(
	subagent: RenderedSubagent,
	summary: StoredSummary,
): Entry {
	const at = subagent.lastActiveAt;
	return {
		id: subagent.throughEventId,
		at,
		text: `[${formatTime(at)} subagent ${subagent.session.id}'s summary]\n${renderSummary(fieldsFromRow(summary))}`,
	};
}

export function renderInput(
	session: SessionHeader,
	summary: SummaryFields | null,
	chunk: Entry[],
): string {
	let header = `Session: ${session.title ?? "untitled"}\nWorking directory: ${session.cwd}`;
	if (session.parentId) {
		header += `\nSubagent of: ${session.parentId}`;
	}
	const entries = chunk.map((entry) => entry.text).join("\n\n");
	if (!summary) {
		return `${header}\n\n## Entries\n\n${entries}`;
	}
	return [
		header,
		`## Summary so far\n\n${renderSummary(summary)}`,
		`## New entries\n\n${entries}`,
	].join("\n\n");
}

export function parseSummary(output: unknown): SummaryFields {
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

export function fieldsFromRow(row: StoredSummary): SummaryFields {
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

export type SummaryFields = {
	objective: string;
	progress: string[];
	tried: string[];
	next: string[];
	blockers: string[];
	waitingOn: StoredSummary["waitingOn"];
	ask: string | null;
	outcome: StoredSummary["outcome"];
};

export type Entry = { id: number; at: Date; text: string };

type SessionHeader = {
	title: string | null;
	cwd: string;
	parentId: string | null;
};

type RenderedSubagent = {
	session: { id: string };
	throughEventId: number;
	lastActiveAt: Date;
};

const MAX_TOOL_CHARS = 300;

const WAITING_ON = ["user", "external", "none"] as const;

const OUTCOMES = ["in_progress", "done", "abandoned"] as const;

export const SYSTEM_PROMPT = `You keep a rolling summary of one AI coding-agent session (Claude Code or Codex).

Two kinds of readers act on it without opening the session transcript:
- Other coding agents read it before they start work, so they don't redo or collide with this session. 
	- They need exact file paths, commands, branch names, commit hashes and error messages, and what already failed.
- The user uses the summaries to get the overall status of their sessions: to see what finished, what is still running, and what is waiting on user.

Input:
- A header names the session and its working directory. A "Subagent of" line means this session is itself a subagent (see Subagent sessions below).
- Entries in time order. 
	- User and assistant messages are in full; very long ones are cut in the middle. 
	- Tool calls are one-line headlines with the tool's name, its target (file, command, URL or pattern) and its outcome: 
		- ok; error; user_denied (a person rejected the call, so the user has already said no); auto_denied (an automatic reviewer refused it and no human decided); or pending (no result recorded yet). 
	- Tool output is not included, so infer results from what the assistant said next.
- Subagents are helper agents the session launched. 
	- Each one appears as its own summary, in these same fields, at the time it was last active. 
	- Their findings and dead ends count as this session's own: 
		- carry what matters into progress and tried with the subagent's exact names and errors. 
		- A subagent's suggestion is a next step only once this session takes it up. 
		- A subagent waiting on the user means this session waits on the user too.
- When a "Summary so far" is given, the entries are only what happened after it. 
	- Return the whole updated summary: 
		- keep what is still true
		- add what the new entries show
		- rewrite or drop what they made obsolete
	- Carry progress and tried items forward, merging related ones to stay within the limits; 
		- never drop a tried item just because the new entries don't mention it. 
	- The objective in the summary so far stays as written: 
		- change it only when the new entries show the goal itself critically changed (the user redirected, replaced or narrowed it)
		- never reword it to describe just the latest activity.

Fields:
Write in plain language. Be precise. Never invent what the entries don't show.
- objective: two parts in one paragraph, written as "Goal: … This session: …". No status, no working directory.
	- Goal: the larger goal this work serves: the project, why it matters, and what done looks like. Take it from what the user said; when they didn't say why or what done means, give only what the entries show.
	- This session: this session's part in that goal, from the first user message to later changes of direction.
- progress: a list of milestones reached, with evidence, the most important first.
	- A milestone is a piece of work the user would care about: a feature or fix landed, a design or decision settled, a review finished, a release shipped.
	- Give each one its evidence: commits with hash and message, PRs, test counts as the session reported them ("212 tests pass"), the files or modules it changed.
	- Merge the steps of one milestone into one item. Leave out trivia: files read, commands re-run, small fixes along the way.
	- Only capture what was actually done, not what was planned.
	- If the last tool calls are still pending, say what was started and that it has no result yet.
	- At most 8 items.
- tried: this is a list of approaches that failed or were dropped, each with "why".
	- capture the underlying issues: the reason the user rejected it, what a subagent looked for and didn't find, a user_denied call with the user's reason when given, an auto_denied call the session worked around. Not open problems (those are blockers), not problems since solved (those are progress, with the fix), and not trivia that teaches nothing, such as a typo fixed on the next try or a network error a retry got past. At most 8 items. Empty if nothing failed.
	- do not capture small pivots.
- next: the remaining steps toward the objective that the session itself stated or committed to. 
	- Never add steps of your own. 
	- An offer or proposal still waiting on the user's answer is the ask, not a step. Empty when nothing remains.
- blockers, waiting_on and ask each answer a different question about the same stop. Fill each one for its own question:
	- blockers: what is stuck?
	- waiting_on: who has the next move?
	- ask: what exactly must the user decide?
- blockers: a list of what is stopping progress right now, whoever has to clear it, written for the user.
	- Each item says what stands in the way and why it matters, readable without the transcript: "\`bun test\` fails in auth.test.ts with ECONNREFUSED because the test database isn't running, so the login fix can't be verified".
	- consider:
		- errors the session couldn't get past
		- a permission or approval it stopped on, including an auto_denied call it stalled on (it may need the user's manual approval or another approach)
		- something only the user can provide or do
		- something external, such as CI, a review or a deploy
	- note: a blocker names the obstacle. Don't restate the ask here; the question for the user goes in \`ask\`.
	- note: dead ends the session routed around belong in \`tried\`, not here. Empty when nothing is stuck.
- waiting_on: who has the next move.
	- user when the session stopped for the user: an unanswered question or choice, an offer or proposal of more work, an approval, a permission, something only the user can do.
	- external when it waits on something outside the session (CI, a review, a deploy, another team).
	- none when the session itself has the next move (it is still working), or nothing is left (done or abandoned).
- ask: the question the user must answer, written so they can answer it without the transcript. Present exactly when waiting_on is user, null otherwise.
	- what is being decided, the options the session offered and its recommendation.
	- the context needed to answer.
	- an offer of more work becomes a yes-or-no question.
- outcome: 
	- mark as \`done\` only when no more work is left. that means when the session's latest report says the work is finished and it proposes nothing further.
	- A session that ends offering or proposing more work, such as pushing, opening a PR or a further fix, is not done: 
		- mark it \`in_progress\` if there is an ask and add it to the \`ask\` field. 
		- mark it \`abandoned\` when the user or the session gave up or moved on without finishing.

Subagent sessions
A subagent was given its task by another agent, and its report goes back to that agent, not to the user. 
Its user messages are that agent's instructions. Apply the fields as above, except:
- waiting_on is user only when a person must act, such as approving a permission it stopped on.
- objective: the Goal is what the launching agent is working toward, as far as the task shows it; This session is the task it was given.
	- A Claude workflow agent gets the user's shared request and then its own computed task: This session is the computed task.
	- A Codex subagent's task is encrypted apart from its header: infer it from the task name and what the subagent did, and state it as the task, without saying how it was inferred.`;

export const SUMMARY_SCHEMA = {
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

import type { App } from "@src/app";
import { describeError } from "@src/utils";
import {
	INPUT_GUIDE,
	LIVE_STATE_GUIDE,
	MODEL,
	NEXT_MOVE_GUIDE,
	type OpusUsage,
	renderInput,
	requireArray,
	requireText,
	type StatusRoot,
	UNANSWERED_CALL,
} from "./utils";

export async function writeBrief(
	app: App,
	roots: StatusRoot[],
	now: Date,
): Promise<Brief> {
	let opus = UNANSWERED_CALL;
	try {
		const response = await app.askClaude({
			model: MODEL,
			effort: "medium",
			systemPrompt: BRIEF_PROMPT,
			input: renderInput(roots, now),
			schema: briefSchema(roots),
		});
		opus = { calls: 1, inputTokens: response.inputTokens };
		const { goals, missing } = parseBrief(response.output, roots);
		return { goals, ungrouped: missing, failure: null, opus };
	} catch (error) {
		return { goals: [], ungrouped: roots, failure: describeError(error), opus };
	}
}

function briefSchema(roots: StatusRoot[]): Record<string, unknown> {
	const text = { type: "string", pattern: "\\S" };
	const list = { type: "array", items: text };
	const goal = {
		type: "object",
		properties: {
			name: text,
			status: { type: "string", enum: STATUSES },
			goal: text,
			done: list,
			blockers: list,
			next: list,
			sessions: {
				type: "array",
				minItems: 1,
				items: { type: "string", enum: roots.map((root) => root.session.id) },
			},
		},
		required: [
			"name",
			"status",
			"goal",
			"done",
			"blockers",
			"next",
			"sessions",
		],
		additionalProperties: false,
	};
	return {
		type: "object",
		properties: { goals: { type: "array", items: goal } },
		required: ["goals"],
		additionalProperties: false,
	};
}

function parseBrief(
	output: unknown,
	roots: StatusRoot[],
): { goals: Goal[]; missing: StatusRoot[] } {
	const byId = new Map(roots.map((root) => [root.session.id, root]));
	const seen = new Set<string>();
	const goals = requireArray(
		(output as { goals?: unknown } | null)?.goals,
		"goals",
	).map((entry) => {
		const value = (entry ?? {}) as Record<string, unknown>;
		const members = requireArray(value.sessions, "a goal's sessions").map(
			(id) => {
				const sessionId = requireText(id, "a session's id");
				const root = byId.get(sessionId);
				if (!root) {
					throw new Error(
						`the answer names a session that wasn't asked about: ${sessionId}`,
					);
				}
				if (seen.has(sessionId)) {
					throw new Error(`the answer lists ${sessionId} more than once`);
				}
				seen.add(sessionId);
				return root;
			},
		);
		return {
			name: requireText(value.name, "a goal's name").replace(/\s+/g, " "),
			status: requireStatus(value.status),
			goal: requireText(value.goal, "a goal's goal"),
			done: requireTextList(value.done, "done"),
			blockers: requireTextList(value.blockers, "blockers"),
			next: requireTextList(value.next, "next"),
			sessions: members,
		};
	});
	return {
		goals: goals.filter((goal) => goal.sessions.length > 0),
		missing: roots.filter((root) => !seen.has(root.session.id)),
	};
}

function requireTextList(value: unknown, name: string): string[] {
	return requireArray(value, name).map((entry) =>
		requireText(entry, `an item of ${name}`).replace(ITEM_MARKER, ""),
	);
}

function requireStatus(value: unknown): Status {
	const status = STATUSES.find((candidate) => candidate === value);
	if (!status) {
		throw new Error(
			`the answer gives a status that isn't one of ${STATUSES.join(", ")}: ${JSON.stringify(value)}`,
		);
	}
	return status;
}

export type Goal = {
	name: string;
	status: Status;
	goal: string;
	done: string[];
	blockers: string[];
	next: string[];
	sessions: StatusRoot[];
};

export type Brief = {
	goals: Goal[];
	ungrouped: StatusRoot[];
	failure: string | null;
	opus: OpusUsage;
};

export type Status = (typeof STATUSES)[number];

export const STATUSES = ["needs_you", "running", "finished"] as const;

const ITEM_MARKER = /^(?:[-*•]|\d+[.)])\s+/;

const BRIEF_PROMPT = `You write a developer's daily brief of their coding-agent work (Claude Code and Codex), organized by goal rather than by session. ${INPUT_GUIDE}

Return goals. Each goal has a name, a status, what it is, what was done, its blockers, what comes next, and the ids of its sessions.

${NEXT_MOVE_GUIDE}
A goal's status is the most urgent of its sessions': it needs_you when any of its sessions needs the developer.

${LIVE_STATE_GUIDE}

Grouping:
- A goal is the outcome the developer is pursuing: a feature, a fix, a release, an investigation, a document. Group sessions that serve the same outcome, even across directories, worktrees and harnesses (a coordinator session and the stream sessions it launched for the same project phase share a goal).
- Don't merge unrelated work into one goal because it shares a directory, and don't split one outcome across goals because its sessions use different branches.
- Every input session belongs to exactly one goal. List its id copied exactly from its "##" heading. Never invent an id.

Order: list the needs_you goals in the order the developer should take them, the most urgent or most unblocking first. The order of the other goals doesn't matter.

Fields, written for the developer, who hasn't read the sessions and reads the brief in a minute. Synthesize across the goal's sessions; never paste a session's text whole. Be brief: keep what changes what the developer does, drop the rest.
- Every list item is one line of at most about 110 characters, plain text: no leading number or bullet (the layout adds them) and no session ids (the layout lists them).
- Keep the exact identifiers that matter (a commit hash, a PR number, a test count, a file name); drop narration about the agents ("The agent then...").
- name: 2 to 6 words, specific and in sentence case: the project and the outcome ("status: summaries command", "Fix flaky login test"). Never a catch-all like "Misc".
- goal: 1 or 2 sentences: what the goal is overall and why it matters, and what done looks like. Take it from the sessions' objectives; when they don't say why or what done means, give only what they show.
- done: the milestones reached, most important first, each with its evidence (a commit, a test count, a file). At most 4 items; merge small steps into the milestone they served. For a finished goal, exactly one item: what it delivered or, when it was abandoned, that it was and why.
- blockers: at most 3: what stands in the way at a high level and why it matters: the obstacles, not the questions. Empty when nothing does.
- next: at most 4 items.
	- needs_you: numbered actions for the developer, in the order to take them. Rewrite each session's ask as a plain action ("Decide whether to cut lamplighter to a kernel; the session recommends yes"), with the options when they matter and the session's recommendation. Include resuming or dropping work that stopped partway. An ask that later work made moot is not an action.
	- running: what the agents are doing now, one item per thread of work.
	- finished: empty.`;

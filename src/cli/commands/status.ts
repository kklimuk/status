import type { App } from "@src/app";
import { type StatusDatabase, sessions, type summaries } from "@src/database";
import type { SessionState } from "@src/harnesses";
import { newestEventIdBySession, summariesBySession } from "@src/summaries";
import { homedir } from "os";
import { parseArgs } from "util";
import {
	type CommandResult,
	colorize,
	failure,
	parseDays,
	refresh,
	usage,
} from "../utils";

export const STATUS_USAGE = "status [--days <n>]";

export async function status(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(STATUS_USAGE));
	}
	if (options.help) {
		return { output: usage(STATUS_USAGE), exitCode: 0 };
	}
	const app = openApp();
	const refreshed = await refresh(app, options.days);
	const now = app.now();
	const since = new Date(now.getTime() - options.days * DAY_MS);
	const triaged = triageRoots(app.database, since);
	const issues = refreshed.issues ? [refreshed.issues] : [];
	if (triaged.length === 0) {
		const output = `No sessions in the last ${pluralize(options.days, "day")}.`;
		return finish(output, issues, refreshed.failed);
	}

	app.progress(`grouping ${pluralize(triaged.length, "session")} by goal`);
	const grouped = await groupByGoal(app, triaged, now);
	const output = [
		renderTally(triaged, options.days),
		...grouped.goals.map((goal) => renderGoal(goal, now)),
	].join("\n\n");
	return finish(
		output,
		[...issues, ...grouped.issues],
		refreshed.failed || grouped.failed,
	);
}

function parseOptions(args: string[]) {
	try {
		const { values } = parseArgs({ args, options: OPTIONS, strict: true });
		return { ...values, days: parseDays(values.days) };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function triageRoots(database: StatusDatabase, since: Date): Triaged[] {
	const rows = sessionRows(database);
	const stored = summariesBySession(database);
	const newestEventIds = newestEventIdBySession(database);
	const childrenByParent = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	return rows
		.filter((row) => row.parentId === null)
		.map((root) => {
			const subagents = descendantsOf(root.id, childrenByParent);
			const summary = stored.get(root.id) ?? null;
			const newestEventId = Math.max(
				...[root, ...subagents].map(
					(member) => newestEventIds.get(member.id) ?? 0,
				),
			);
			const lastActiveAt = new Date(
				Math.max(
					+root.lastEventAt,
					...subagents.map((subagent) => +subagent.lastEventAt),
				),
			);
			return {
				session: root,
				summary,
				subagents,
				lastActiveAt,
				busySubagentObjectives: subagents
					.filter((subagent) => subagent.state === "busy")
					.map(
						(subagent) =>
							stored.get(subagent.id)?.objective ??
							subagent.title ??
							"no summary yet",
					),
				behind: summary === null || newestEventId > summary.throughEventId,
				...bucketOf(root.state, summary, subagents),
			};
		})
		.filter((triaged) => triaged.lastActiveAt >= since)
		.sort((left, right) => +right.lastActiveAt - +left.lastActiveAt);
}

function descendantsOf(
	sessionId: string,
	childrenByParent: Map<string | null, SessionRow[]>,
): SessionRow[] {
	return (childrenByParent.get(sessionId) ?? []).flatMap((child) => [
		child,
		...descendantsOf(child.id, childrenByParent),
	]);
}

function bucketOf(
	state: SessionState,
	summary: SummaryRow | null,
	subagents: SessionRow[],
): { bucket: Bucket; reason: string } {
	if (state === "waiting") {
		return { bucket: "blocked", reason: "a prompt or question is open" };
	}
	if (subagents.some((subagent) => subagent.state === "waiting")) {
		return {
			bucket: "blocked",
			reason: "a subagent's prompt or question is open",
		};
	}
	if (state === "busy") {
		return { bucket: "running", reason: "the agent is working" };
	}
	if (subagents.some((subagent) => subagent.state === "busy")) {
		return { bucket: "running", reason: "a subagent is working" };
	}
	if (summary === null && state === "idle") {
		return { bucket: "blocked", reason: "idle, with no summary yet" };
	}
	if (summary === null) {
		return { bucket: "finished", reason: "ended, with no summary yet" };
	}
	if (summary.outcome !== "in_progress") {
		return { bucket: "finished", reason: `ended its work: ${summary.outcome}` };
	}
	if (state === "idle" && summary.waitingOn === "external") {
		return { bucket: "running", reason: "idle, waiting on something external" };
	}
	if (state === "idle") {
		return { bucket: "blocked", reason: "its turn ended with work left" };
	}
	return { bucket: "blocked", reason: "the session ended with work left" };
}

async function groupByGoal(
	app: App,
	triaged: Triaged[],
	now: Date,
): Promise<Grouped> {
	try {
		const response = await app.askClaude({
			model: MODEL,
			effort: "medium",
			systemPrompt: SYSTEM_PROMPT,
			input: renderInput(triaged, now),
			schema: groupingSchema(triaged),
		});
		const { goals, missing } = parseGrouping(response.output, triaged);
		if (missing.length === 0) {
			return { goals: sortGoals(goals), issues: [], failed: false };
		}
		const missingIds = missing.map((item) => item.session.id);
		return {
			goals: sortGoals([...goals, ungrouped(missing)]),
			issues: [
				`${colorize("warning:", "muted")} the grouping left out ${missingIds.join(", ")}, shown under "${UNGROUPED_GOAL}"`,
			],
			failed: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			goals: [ungrouped(triaged)],
			issues: [`${colorize("failed:", "error")} grouping by goal: ${message}`],
			failed: true,
		};
	}
}

function renderInput(triaged: Triaged[], now: Date): string {
	const blocks = triaged.map((item) => {
		const { session, summary } = item;
		const lines = [
			`## ${session.id}`,
			`bucket: ${item.bucket} (${item.reason})`,
			`live state: ${session.state}`,
			`title: ${session.title ?? "none"}`,
			`directory: ${session.cwd}`,
			`branch: ${session.branch ?? "none"}`,
			`last activity: ${formatAge(item.lastActiveAt, now)}`,
			`subagents: ${item.subagents.length}, ${item.busySubagentObjectives.length} busy`,
			...item.busySubagentObjectives.map(
				(objective) => `- busy subagent: ${objective}`,
			),
		];
		if (summary === null) {
			return [...lines, "summary: none"].join("\n");
		}
		return [
			...lines,
			`summary${item.behind ? BEHIND_NOTE : ""}:`,
			`objective: ${summary.objective}`,
			renderList("progress", summary.progress),
			renderList("next", summary.next),
			renderList("blockers", summary.blockers),
			`waiting on: ${summary.waitingOn}`,
			...(summary.ask ? [`ask: ${summary.ask}`] : []),
			`outcome: ${summary.outcome}`,
		].join("\n");
	});
	return [`Now: ${now.toISOString()}`, ...blocks].join("\n\n");
}

function renderList(name: string, column: string): string {
	const items = splitList(column);
	if (items.length === 0) {
		return `${name}: none`;
	}
	return [`${name}:`, ...items.map((entry) => `- ${entry}`)].join("\n");
}

function splitList(column: string): string[] {
	return column.split("\n").filter((entry) => entry.trim() !== "");
}

function groupingSchema(triaged: Triaged[]): Record<string, unknown> {
	const text = { type: "string", pattern: "\\S" };
	const session = {
		type: "object",
		properties: {
			id: { type: "string", enum: triaged.map((item) => item.session.id) },
			line: text,
		},
		required: ["id", "line"],
		additionalProperties: false,
	};
	const goal = {
		type: "object",
		properties: { name: text, sessions: { type: "array", items: session } },
		required: ["name", "sessions"],
		additionalProperties: false,
	};
	return {
		type: "object",
		properties: { goals: { type: "array", items: goal } },
		required: ["goals"],
		additionalProperties: false,
	};
}

function parseGrouping(
	output: unknown,
	triaged: Triaged[],
): { goals: Goal[]; missing: Triaged[] } {
	const byId = new Map(triaged.map((item) => [item.session.id, item]));
	const seen = new Set<string>();
	const goals = requireArray(
		(output as { goals?: unknown } | null)?.goals,
		"goals",
	).map((goal) => ({
		name: requireText(
			(goal as { name?: unknown })?.name,
			"a goal's name",
		).replace(/\s+/g, " "),
		sessions: requireArray(
			(goal as { sessions?: unknown })?.sessions,
			"a goal's sessions",
		).map((entry) => {
			const id = requireText((entry as { id?: unknown })?.id, "a session's id");
			const item = byId.get(id);
			if (!item) {
				throw new Error(
					`the answer names a session that wasn't asked about: ${id}`,
				);
			}
			if (seen.has(id)) {
				throw new Error(`the answer lists ${id} more than once`);
			}
			seen.add(id);
			const line = requireText(
				(entry as { line?: unknown })?.line,
				"a session's line",
			);
			return { ...item, line };
		}),
	}));
	return {
		goals: goals.filter((goal) => goal.sessions.length > 0),
		missing: triaged.filter((item) => !seen.has(item.session.id)),
	};
}

function requireArray(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`the answer's ${name} isn't a list`);
	}
	return value;
}

function requireText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`the answer is missing ${name}`);
	}
	return value.trim();
}

function ungrouped(triaged: Triaged[]): Goal {
	return {
		name: UNGROUPED_GOAL,
		sessions: triaged.map((item) => ({
			...item,
			line: item.summary?.objective ?? item.session.title ?? "no summary yet",
		})),
	};
}

function sortGoals(goals: Goal[]): Goal[] {
	return goals
		.map((goal) => ({ goal, ...urgencyOf(goal) }))
		.sort(
			(left, right) => left.rank - right.rank || +right.latest - +left.latest,
		)
		.map(({ goal }) => goal);
}

function urgencyOf(goal: Goal): { rank: number; latest: Date } {
	return {
		rank: Math.min(
			...goal.sessions.map((item) => BUCKETS.indexOf(item.bucket)),
		),
		latest: new Date(
			Math.max(...goal.sessions.map((item) => +item.lastActiveAt)),
		),
	};
}

function renderTally(triaged: Triaged[], days: number): string {
	const counts = BUCKETS.map((bucket) => {
		const count = triaged.filter((item) => item.bucket === bucket).length;
		return colorize(`${count} ${BUCKET_LABELS[bucket]}`, bucket);
	});
	return `${counts.join(" · ")}  ${colorize(`last ${pluralize(days, "day")}`, "muted")}`;
}

function renderGoal(goal: Goal, now: Date): string {
	const buckets = BUCKETS.flatMap((bucket) => {
		const members = goal.sessions
			.filter((item) => item.bucket === bucket)
			.sort((left, right) => +right.lastActiveAt - +left.lastActiveAt);
		if (members.length === 0) {
			return [];
		}
		return [
			`  ${colorize(BUCKET_LABELS[bucket], bucket)}`,
			...members.flatMap((item) => renderSession(item, now)),
		];
	});
	return [colorize(goal.name, "heading"), ...buckets].join("\n");
}

function renderSession(item: GoalSession, now: Date): string[] {
	const { session } = item;
	const directory = shortenHome(session.cwd);
	const place = session.branch ? `${directory} (${session.branch})` : directory;
	const details = [session.state, place, formatAge(item.lastActiveAt, now)];
	if (item.summary === null) {
		details.push("no summary");
	} else if (item.behind) {
		details.push("summary behind");
	}
	const lines = [
		`    ${session.id}  ${colorize(details.join(" · "), "muted")}`,
		`      ${item.line.replace(/\s+/g, " ")}`,
	];
	const ask = askOf(item);
	if (!ask) {
		return lines;
	}
	const askLines = `ask: ${ask}`
		.split("\n")
		.filter((line) => line.trim() !== "");
	return [
		...lines,
		...askLines.map((line, index) =>
			colorize(`${index === 0 ? "      " : "        "}${line}`, "blocked"),
		),
	];
}

function askOf(item: GoalSession): string | null {
	if (item.bucket !== "blocked") {
		return null;
	}
	if (item.summary?.ask) {
		return item.summary.ask;
	}
	if (item.session.state === "waiting") {
		return "a permission prompt or question is open in the session";
	}
	if (item.subagents.some((subagent) => subagent.state === "waiting")) {
		return "a permission prompt or question is open in a subagent";
	}
	return null;
}

function shortenHome(path: string): string {
	const home = homedir();
	if (path !== home && !path.startsWith(`${home}/`)) {
		return path;
	}
	return `~${path.slice(home.length)}`;
}

function formatAge(at: Date, now: Date): string {
	const minutes = Math.floor((+now - +at) / 60_000);
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	if (minutes < 48 * 60) {
		return `${Math.floor(minutes / 60)}h ago`;
	}
	return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function finish(
	output: string,
	issues: string[],
	failed: boolean,
): CommandResult {
	return {
		output: [output, ...issues].join("\n\n"),
		exitCode: failed ? 1 : 0,
	};
}

function sessionRows(database: StatusDatabase): SessionRow[] {
	return database
		.select({
			id: sessions.id,
			parentId: sessions.parentId,
			title: sessions.title,
			cwd: sessions.cwd,
			branch: sessions.branch,
			state: sessions.state,
			lastEventAt: sessions.lastEventAt,
		})
		.from(sessions)
		.all();
}

type SessionRow = {
	id: string;
	parentId: string | null;
	title: string | null;
	cwd: string;
	branch: string | null;
	state: SessionState;
	lastEventAt: Date;
};

type SummaryRow = typeof summaries.$inferSelect;

type Bucket = (typeof BUCKETS)[number];

type Triaged = {
	session: SessionRow;
	summary: SummaryRow | null;
	subagents: SessionRow[];
	busySubagentObjectives: string[];
	lastActiveAt: Date;
	behind: boolean;
	bucket: Bucket;
	reason: string;
};

type GoalSession = Triaged & { line: string };

type Goal = { name: string; sessions: GoalSession[] };

type Grouped = { goals: Goal[]; issues: string[]; failed: boolean };

const OPTIONS = {
	days: { type: "string", default: "7" },
	help: { type: "boolean", short: "h" },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const MODEL = "claude-opus-5-5";

const BUCKETS = ["blocked", "running", "finished"] as const;

const BUCKET_LABELS: Record<Bucket, string> = {
	blocked: "blocked on you",
	running: "running",
	finished: "finished",
};

const UNGROUPED_GOAL = "Not grouped";

const BEHIND_NOTE = " (behind: the session has moved on since it was written)";

const SYSTEM_PROMPT = `You prepare a developer's morning triage of their coding-agent sessions (Claude Code and Codex). The input lists each root session active recently: its bucket, live state, directory, branch, last activity and a rolling summary of what it did. Subagents are already folded into their parent's summary.

Return goals, each with its sessions, and one line per session.

Goals:
- A goal is the outcome the developer is pursuing: a feature, a fix, a release, an investigation, a document. Group sessions that serve the same outcome, even across directories, worktrees and harnesses (a coordinator session and the stream sessions it launched for the same project phase share a goal).
- Don't merge unrelated work into one goal because it shares a directory, and don't split one outcome across goals because its sessions use different branches.
- Name a goal in 2 to 6 words, specific and in sentence case: the project and the outcome ("status: summaries command", "Fix flaky login test"). Never a catch-all like "Misc" or "Other work". A session that fits no other goal gets its own.

Sessions:
- List every input session exactly once, under one goal, with its id copied exactly from its "##" heading. Never invent an id.
- The bucket is fixed: it comes from the live state and the summary. Write the line to fit it, and never contradict it.
- One line, at most about 120 characters, plain language, no session id. Say what the developer needs for that bucket:
  - blocked: where the work stands and what it needs from the developer. The session's ask is printed under your line verbatim, so don't restate it; give the context that makes it quick to answer. When the session stopped with work left and no ask, say what's left.
  - running: what it's doing now.
  - finished: what it delivered, with commit hashes, PR numbers or file names when the summary has them. When the outcome is abandoned, say so and why.
- A summary marked behind may lag the session; describe what it does say, without guessing past it.
- Keep exact identifiers (commands, hashes, file names) when they help; drop narration about the agent ("The agent then...").`;

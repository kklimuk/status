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
		renderTally(grouped.goals, options.days),
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
				liveSubagents: subagents
					.filter((subagent) => subagent.state !== "ended")
					.map((subagent) => ({
						state: subagent.state,
						objective:
							stored.get(subagent.id)?.objective ??
							subagent.title ??
							"no summary yet",
					})),
				behind: summary === null || newestEventId > summary.throughEventId,
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
			`live state: ${session.state}`,
			`title: ${session.title ?? "none"}`,
			`directory: ${session.cwd}`,
			`branch: ${session.branch ?? "none"}`,
			`last activity: ${item.lastActiveAt.toISOString()} (${formatAge(item.lastActiveAt, now)})`,
			`subagents: ${item.subagents.length}, ${item.liveSubagents.length} not ended`,
			...item.liveSubagents.map(
				(subagent) => `- ${subagent.state} subagent: ${subagent.objective}`,
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
			bucket: { type: "string", enum: BUCKETS },
			line: text,
		},
		required: ["id", "bucket", "line"],
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
			const bucket = requireBucket((entry as { bucket?: unknown })?.bucket);
			const line = requireText(
				(entry as { line?: unknown })?.line,
				"a session's line",
			);
			return { ...item, bucket, line };
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

function requireBucket(value: unknown): Bucket {
	const bucket = BUCKETS.find((candidate) => candidate === value);
	if (!bucket) {
		throw new Error(
			`the answer gives a bucket that isn't one of ${BUCKETS.join(", ")}: ${JSON.stringify(value)}`,
		);
	}
	return bucket;
}

function ungrouped(triaged: Triaged[]): Goal {
	return {
		name: UNGROUPED_GOAL,
		sessions: triaged.map((item) => ({
			...item,
			bucket: null,
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
		rank: Math.min(...goal.sessions.map((item) => rankOf(item.bucket))),
		latest: new Date(
			Math.max(...goal.sessions.map((item) => +item.lastActiveAt)),
		),
	};
}

function rankOf(bucket: Bucket | null): number {
	return bucket === null ? BUCKETS.length : BUCKETS.indexOf(bucket);
}

function renderTally(goals: Goal[], days: number): string {
	const listed = goals.flatMap((goal) => goal.sessions);
	const judged = listed.some((item) => item.bucket !== null);
	const counts = judged
		? BUCKETS.map((bucket) => {
				const count = listed.filter((item) => item.bucket === bucket).length;
				return colorize(`${count} ${BUCKET_LABELS[bucket]}`, bucket);
			})
		: [];
	const ungroupedCount = listed.filter((item) => item.bucket === null).length;
	if (ungroupedCount > 0) {
		counts.push(`${ungroupedCount} not grouped`);
	}
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
	const unbucketed = goal.sessions
		.filter((item) => item.bucket === null)
		.flatMap((item) => renderSession(item, now));
	return [colorize(goal.name, "heading"), ...buckets, ...unbucketed].join("\n");
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
	if (item.bucket === "running" || item.bucket === "finished") {
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
	liveSubagents: { state: SessionState; objective: string }[];
	lastActiveAt: Date;
	behind: boolean;
};

type GoalSession = Triaged & { bucket: Bucket | null; line: string };

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

const SYSTEM_PROMPT = `You prepare a developer's morning triage of their coding-agent sessions (Claude Code and Codex). The input lists each root session active recently: its live state, directory, branch, last activity, the subagents that haven't ended, and a rolling summary of what it did. Subagents' work is already folded into their parent's summary.

Return goals, each with its sessions, and for each session a bucket and one line.

Buckets: judge each session by who has the next move.
- blocked: the next move is the developer's. They must answer, approve, decide, review, or resume or drop work that stopped partway.
- running: an agent or something external (a build, CI, a background job, another person) is making progress, and the developer needn't act yet.
- finished: nothing is left for anyone. The work is delivered or deliberately abandoned, and nothing is proposed or pending.

Live states, as observed just now:
- waiting: a permission prompt or a question is open in the session right now; someone has to answer it before it continues.
- busy: the agent is working on a turn right now.
- idle: the session is open but its turn ended; it continues only when someone sends a message, unless something it started (a background job) wakes it.
- ended: the process is gone. Nothing runs until the developer resumes it.
A subagent's state counts toward its root: a waiting subagent holds its root on the same prompt, a busy one is still working for it, and an idle one waits on its root, not on the developer.

Weigh the live state with the summary. The summary's outcome, waiting on, ask, next and blockers say what the session thought was left when its summary was written; the live state and last activity say what's true now. An open ask on an ended session may be stale, or may still be the decision the developer owes: judge from its age and whether later work moved past it. A summary marked behind may lag the session; don't guess past what it says, and lean on the live state.

Goals:
- A goal is the outcome the developer is pursuing: a feature, a fix, a release, an investigation, a document. Group sessions that serve the same outcome, even across directories, worktrees and harnesses (a coordinator session and the stream sessions it launched for the same project phase share a goal).
- Don't merge unrelated work into one goal because it shares a directory, and don't split one outcome across goals because its sessions use different branches.
- Name a goal in 2 to 6 words, specific and in sentence case: the project and the outcome ("status: summaries command", "Fix flaky login test"). Never a catch-all like "Misc" or "Other work". A session that fits no other goal gets its own.

Sessions:
- List every input session exactly once, under one goal, with its id copied exactly from its "##" heading. Never invent an id.
- One line, at most about 120 characters, plain language, no session id, that fits the bucket you chose:
  - blocked: where the work stands and what the developer needs to do. The session's ask, when it has one, is printed under your line verbatim, so don't restate it; give the context that makes it quick to answer. With no ask, say what's needed.
  - running: what it's doing now.
  - finished: what it delivered, with commit hashes, PR numbers or file names when the summary has them. When it was abandoned, say so and why.
- Keep exact identifiers (commands, hashes, file names) when they help; drop narration about the agent ("The agent then...").`;

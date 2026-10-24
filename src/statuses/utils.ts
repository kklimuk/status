import { type StatusDatabase, sessions, type summaries } from "@src/database";
import type { SessionState } from "@src/harnesses";
import { newestEventIdBySession, summariesBySession } from "@src/summaries";

export function rootsInWindow(
	database: StatusDatabase,
	since: Date,
): StatusRoot[] {
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
		.filter((root) => root.lastActiveAt >= since)
		.sort((left, right) => +right.lastActiveAt - +left.lastActiveAt);
}

export function renderInput(roots: StatusRoot[], now: Date): string {
	const blocks = roots.map((root) => {
		const { session, summary } = root;
		const lines = [
			`## ${session.id}`,
			`live state: ${session.state}`,
			`title: ${session.title ?? "none"}`,
			`directory: ${session.cwd}`,
			`branch: ${session.branch ?? "none"}`,
			`last activity: ${root.lastActiveAt.toISOString()} (${formatAge(root.lastActiveAt, now)})`,
			`subagents: ${root.subagents.length}, ${root.liveSubagents.length} not ended`,
			...root.liveSubagents.map(
				(subagent) => `- ${subagent.state} subagent: ${subagent.objective}`,
			),
		];
		if (summary === null) {
			return [...lines, "summary: none"].join("\n");
		}
		return [
			...lines,
			`summary${root.behind ? BEHIND_NOTE : ""}:`,
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

export function requireArray(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`the answer's ${name} isn't a list`);
	}
	return value;
}

export function requireText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`the answer is missing ${name}`);
	}
	return value.trim();
}

export function formatAge(at: Date, now: Date): string {
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

function descendantsOf(
	sessionId: string,
	childrenByParent: Map<string | null, SessionRow[]>,
): SessionRow[] {
	return (childrenByParent.get(sessionId) ?? []).flatMap((child) => [
		child,
		...descendantsOf(child.id, childrenByParent),
	]);
}

function renderList(name: string, column: string): string {
	const items = column.split("\n").filter((entry) => entry.trim() !== "");
	if (items.length === 0) {
		return `${name}: none`;
	}
	return [`${name}:`, ...items.map((entry) => `- ${entry}`)].join("\n");
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

export type StatusRoot = {
	session: SessionRow;
	summary: SummaryRow | null;
	subagents: SessionRow[];
	liveSubagents: { state: SessionState; objective: string }[];
	lastActiveAt: Date;
	behind: boolean;
};

export type OpusUsage = { calls: number; inputTokens: number };

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

export const MODEL = "claude-opus-5-5";

export const UNANSWERED_CALL: OpusUsage = { calls: 1, inputTokens: 0 };

const BEHIND_NOTE = " (behind: the session has moved on since it was written)";

export const INPUT_GUIDE = `The input lists each root session active recently: its live state, directory, branch, last activity, the subagents that haven't ended, and a rolling summary of what it did. Subagents' work is already folded into their parent's summary.`;

export const NEXT_MOVE_GUIDE = `Statuses: judge each session by who has the next move.
- needs_you: the next move is the developer's. They must answer, approve, decide, review, or resume or drop work that stopped partway.
- running: an agent or something external (a build, CI, a background job, another person) is making progress, and the developer needn't act yet.
- finished: nothing is left for anyone. The work is delivered or deliberately abandoned, and nothing is proposed or pending.`;

export const LIVE_STATE_GUIDE = `Live states, as observed just now:
- waiting: a permission prompt or a question is open in the session right now; someone has to answer it before it continues.
- busy: the agent is working on a turn right now.
- idle: the session is open but its turn ended; it continues only when someone sends a message, unless something it started (a background job) wakes it.
- ended: the process is gone. Nothing runs until the developer resumes it.
A subagent's state counts toward its root: a waiting subagent holds its root on the same prompt, a busy one is still working for it, and an idle one waits on its root, not on the developer.

Weigh the live state with the summary. The summary's outcome, waiting on, ask, next and blockers say what the session thought was left when its summary was written; the live state and last activity say what's true now. An open ask on an ended session may be stale, or may still be the decision the developer owes: judge from its age and whether later work moved past it. A summary marked behind may lag the session; don't guess past what it says, and lean on the live state.`;

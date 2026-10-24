import type { App } from "@src/app";
import { events, type StatusDatabase, sessions } from "@src/database";
import type { SessionState } from "@src/harnesses";
import { newestEventIdBySession, summariesBySession } from "@src/summaries";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { join } from "path";
import { parseArgs } from "util";
import {
	type CommandResult,
	colorize,
	failure,
	parseDays,
	type Refresh,
	refresh,
	usage,
} from "../utils";

export const SUMMARIES_USAGE =
	"status summaries [--days <n>] [--all] [--session <id>]";

export async function summaries(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(SUMMARIES_USAGE));
	}
	if (options.help) {
		return { output: usage(SUMMARIES_USAGE), exitCode: 0 };
	}
	const app = openApp();
	const refreshed = await refresh(app, options.days);
	const catalog = readCatalog(app);
	if (options.session !== undefined) {
		const session = catalog.sessions.get(options.session);
		if (!session) {
			const unknown = failure(`unknown session "${options.session}"`);
			return { ...finish(unknown.output, refreshed), exitCode: 1 };
		}
		return finish(renderSession(app, catalog, session), refreshed);
	}
	const callers = await callerSessionIds(app);
	const since = new Date(app.now().getTime() - options.days * DAY_MS);
	const isListed = (session: SessionRow) =>
		!callers.ids.has(session.id) &&
		(session.state !== "ended" ||
			(options.all === true && session.lastEventAt >= since));
	const filter = { isListed, callers: callers.ids, all: options.all === true };
	return finish(renderList(app, catalog, filter), refreshed, callers.warnings);
}

function parseOptions(args: string[]) {
	try {
		const { values } = parseArgs({ args, options: OPTIONS, strict: true });
		return { ...values, days: parseDays(values.days) };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function readCatalog(app: App): Catalog {
	const rows = sessionRows(app.database).sort(
		(left, right) =>
			+right.startedAt - +left.startedAt || left.id.localeCompare(right.id),
	);
	const children = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	const stored = summariesBySession(app.database);
	const newestEventIds = newestEventIdBySession(app.database);
	const familyNewest = new Map<string, number>();
	function newestInFamily(id: string): number {
		const known = familyNewest.get(id);
		if (known !== undefined) {
			return known;
		}
		const newest = Math.max(
			newestEventIds.get(id) ?? 0,
			...(children.get(id) ?? []).map((child) => newestInFamily(child.id)),
		);
		familyNewest.set(id, newest);
		return newest;
	}
	const editedSince = new Date(app.now().getTime() - EDIT_WINDOW_MS);
	return {
		sessions: new Map(rows.map((row) => [row.id, row])),
		children,
		summaries: stored,
		behind: new Set(
			rows
				.filter((row) => {
					const summary = stored.get(row.id);
					return summary && newestInFamily(row.id) > summary.throughEventId;
				})
				.map((row) => row.id),
		),
		edits: editCallsSince(app.database, editedSince),
	};
}

function finish(
	output: string,
	refreshed: Refresh,
	warnings: string[] = [],
): CommandResult {
	const issues = [
		refreshed.issues,
		...warnings.map((text) => `${colorize("warning:", "muted")} ${text}`),
	]
		.filter((text) => text !== "")
		.join("\n");
	return {
		output: issues ? `${output}\n\n${issues}` : output,
		exitCode: refreshed.failed ? 1 : 0,
	};
}

function renderSession(app: App, catalog: Catalog, session: SessionRow) {
	const edits = editedFiles(catalog, (member) =>
		entryOf(catalog, member, (entry) => entry.id === session.id, new Set()),
	);
	const lines = renderEntry(app, catalog, session, {
		depth: 0,
		under: null,
		callers: new Set(),
		edited: edits.get(session.id) ?? [],
	});
	const subagents: string[] = [];
	function visit(parentId: string, depth: number) {
		for (const child of catalog.children.get(parentId) ?? []) {
			const objective = catalog.summaries.get(child.id)?.objective;
			const indent = "  ".repeat(depth);
			subagents.push(`${indent}${headline(app, catalog, child)}`);
			if (child.title) {
				subagents.push(`${indent}  ${child.title}`);
			}
			if (objective) {
				subagents.push(`${indent}  ${objective}`);
			}
			visit(child.id, depth + 1);
		}
	}
	visit(session.id, 1);
	lines.push(
		"",
		colorize("subagents:", "heading"),
		...(subagents.length > 0 ? subagents : ["  none"]),
	);
	const tools = recentToolCalls(app.database, session.id, RECENT_TOOL_CALLS);
	lines.push(
		"",
		colorize(`recent tool calls (last ${RECENT_TOOL_CALLS}):`, "heading"),
	);
	if (tools.length === 0) {
		lines.push("  none");
	}
	for (const tool of tools.reverse()) {
		const target = clip(tool.toolTarget?.split("\n").join(", ") ?? "");
		lines.push(
			`  ${minute(tool.at)}  ${tool.toolName ?? "unknown"}  ${tool.toolStatus ?? "pending"}  ${target}`.trimEnd(),
		);
	}
	return lines.join("\n");
}

function editedFiles(
	catalog: Catalog,
	ownerOf: (session: SessionRow) => string | null,
): Map<string, string[]> {
	const files = new Map<string, Set<string>>();
	for (const edit of catalog.edits) {
		const session = catalog.sessions.get(edit.sessionId);
		const owner = session ? ownerOf(session) : null;
		if (owner === null) {
			continue;
		}
		const owned = files.get(owner) ?? new Set();
		for (const file of splitItems(edit.toolTarget ?? "")) {
			owned.add(file);
		}
		files.set(owner, owned);
	}
	return new Map([...files].map(([id, owned]) => [id, [...owned]]));
}

function entryOf(
	catalog: Catalog,
	session: SessionRow,
	hasEntry: (session: SessionRow) => boolean,
	callers: Set<string>,
): string | null {
	for (const member of [session, ...ancestorsOf(catalog, session)]) {
		if (callers.has(member.id)) {
			return null;
		}
		if (hasEntry(member)) {
			return member.id;
		}
	}
	return null;
}

function ancestorsOf(catalog: Catalog, session: SessionRow): SessionRow[] {
	const ancestors: SessionRow[] = [];
	let parentId = session.parentId;
	while (parentId !== null) {
		const parent = catalog.sessions.get(parentId);
		if (!parent) {
			break;
		}
		ancestors.push(parent);
		parentId = parent.parentId;
	}
	return ancestors;
}

function renderEntry(
	app: App,
	catalog: Catalog,
	session: SessionRow,
	placement: Placement,
): string[] {
	const summary = catalog.summaries.get(session.id);
	const lines = [headline(app, catalog, session)];
	const field = (label: string, value: string) => {
		const [first, ...rest] = value.split("\n");
		const name = colorize(`${label}:`, "muted");
		lines.push(`  ${name} ${first}`, ...rest.map((line) => `    ${line}`));
	};
	if (session.title) {
		field("title", session.title);
	}
	const parent = session.parentId;
	if (parent !== null && parent !== placement.under) {
		const yours = placement.callers.has(parent) ? " (this session)" : "";
		field("parent", `${parent}${yours}`);
	}
	field("cwd", session.cwd);
	field("branch", session.branch ?? "none");
	if (summary) {
		field("objective", summary.objective);
		field("outcome", `${summary.outcome}, waiting on ${summary.waitingOn}`);
		if (summary.waitingOn === "user" && summary.ask) {
			field("ask", summary.ask);
		}
		for (const [label, column] of LIST_FIELDS) {
			lines.push(...listField(label, splitItems(summary[column])));
		}
	}
	lines.push(...listField(EDITED_LABEL, placement.edited));
	const indent = "    ".repeat(placement.depth);
	return lines.map((line) => `${indent}${line}`);
}

function headline(app: App, catalog: Catalog, session: SessionRow): string {
	const parts = [
		colorize(session.id, "heading"),
		colorize(session.state, STATE_TONES[session.state]),
		`active ${age(app.now(), session.lastEventAt)}`,
	];
	if (!catalog.summaries.has(session.id)) {
		parts.push(colorize("no summary yet", "blocked"));
	} else if (catalog.behind.has(session.id)) {
		parts.push(colorize("summary behind", "blocked"));
	}
	return parts.join("  ");
}

function age(now: Date, then: Date): string {
	const minutes = Math.max(0, Math.floor((+now - +then) / 60_000));
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	if (minutes < 48 * 60) {
		return `${Math.floor(minutes / 60)}h ago`;
	}
	return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function listField(label: string, items: string[]): string[] {
	const name = colorize(`${label}:`, "muted");
	if (items.length === 0) {
		return [`  ${name} none`];
	}
	return [`  ${name}`, ...items.map((item) => `    - ${item}`)];
}

function splitItems(column: string): string[] {
	return column.split("\n").filter((item) => item.trim() !== "");
}

function clip(text: string): string {
	if (text.length <= MAX_TARGET_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_TARGET_CHARS)}…`;
}

function minute(at: Date): string {
	return `${at.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

async function callerSessionIds(app: App): Promise<Callers> {
	const ids = new Set<string>();
	if (process.env.CODEX_THREAD_ID) {
		ids.add(`codex:${process.env.CODEX_THREAD_ID}`);
	}
	try {
		const claudeSession = await claudeSessionAbove(
			join(app.paths.claude, "sessions"),
			process.pid,
		);
		if (claudeSession) {
			ids.add(claudeSession);
		}
		return { ids, warnings: [] };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const warning = `couldn't find the Claude session running this, so it may be listed: ${reason}`;
		return { ids, warnings: [warning] };
	}
}

async function claudeSessionAbove(
	directory: string,
	pid: number,
): Promise<string | null> {
	let current = pid;
	for (let hop = 0; current > 1 && hop < MAX_PROCESS_HOPS; hop += 1) {
		const owner = await processOf(current);
		if (!owner) {
			return null;
		}
		const sessionId = await claudeSessionOfProcess(
			join(directory, `${current}.json`),
			current,
			owner.started,
		);
		if (sessionId) {
			return `claude:${sessionId}`;
		}
		current = owner.parent;
	}
	return null;
}

async function processOf(
	pid: number,
): Promise<{ parent: number; started: string } | null> {
	const result = await Bun.$`ps -o ppid=,lstart= -p ${pid}`
		.env({ ...process.env, LC_ALL: "C", TZ: "UTC" })
		.nothrow()
		.quiet();
	const output = result.stdout.toString().trim();
	const errors = result.stderr.toString().trim();
	// fact: ps exits 1 with no output and no error when the pid isn't running.
	if (result.exitCode === 1 && output === "" && errors === "") {
		return null;
	}
	const match = PS_LINE.exec(output);
	if (result.exitCode !== 0 || !match) {
		throw new Error(
			`ps -p ${pid} exited ${result.exitCode} with "${output}": ${errors}`,
		);
	}
	return { parent: Number(match[1]), started: collapseSpaces(match[2] ?? "") };
}

async function claudeSessionOfProcess(
	path: string,
	pid: number,
	started: string,
): Promise<string | null> {
	try {
		const record = await Bun.file(path).json();
		if (record?.pid !== pid || typeof record.sessionId !== "string") {
			return null;
		}
		const isSameProcess =
			typeof record.procStart !== "string" ||
			collapseSpaces(record.procStart) === started;
		return isSameProcess ? record.sessionId : null;
	} catch {
		return null;
	}
}

function collapseSpaces(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function renderList(app: App, catalog: Catalog, filter: ListFilter): string {
	const listed = [...catalog.sessions.values()].filter(filter.isListed);
	const placed = Map.groupBy(
		listed,
		(session) =>
			ancestorsOf(catalog, session).find(filter.isListed)?.id ?? null,
	);
	const edits = editedFiles(catalog, (session) =>
		entryOf(catalog, session, filter.isListed, filter.callers),
	);
	const lines = [listHeading(listed.length, filter)];
	function place(session: SessionRow, depth: number, under: string | null) {
		const placement = {
			depth,
			under,
			callers: filter.callers,
			edited: edits.get(session.id) ?? [],
		};
		lines.push("", ...renderEntry(app, catalog, session, placement));
		for (const child of placed.get(session.id) ?? []) {
			place(child, depth + 1, session.id);
		}
	}
	for (const top of placed.get(null) ?? []) {
		place(top, 0, null);
	}
	return lines.join("\n");
}

function listHeading(count: number, filter: ListFilter): string {
	const noun = count === 1 ? "session" : "sessions";
	const scope = filter.all ? `${count} ${noun}` : `${count} live ${noun}`;
	if (filter.callers.size === 0) {
		return colorize(scope, "heading");
	}
	const callers = [...filter.callers].join(", ");
	return colorize(`${scope}, leaving out this session: ${callers}`, "heading");
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
			startedAt: sessions.startedAt,
			lastEventAt: sessions.lastEventAt,
		})
		.from(sessions)
		.all();
}

function editCallsSince(database: StatusDatabase, since: Date): EditCall[] {
	return database
		.select({ sessionId: events.sessionId, toolTarget: events.toolTarget })
		.from(events)
		.where(
			and(
				inArray(events.toolName, EDIT_TOOLS),
				inArray(events.toolStatus, ["ok", "pending"]),
				isNotNull(events.toolTarget),
				gte(events.at, since),
			),
		)
		.orderBy(desc(events.at), desc(events.id))
		.all();
}

function recentToolCalls(
	database: StatusDatabase,
	sessionId: string,
	limit: number,
) {
	return database
		.select({
			at: events.at,
			toolName: events.toolName,
			toolTarget: events.toolTarget,
			toolStatus: events.toolStatus,
		})
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.role, "tool")))
		.orderBy(desc(events.at), desc(events.id))
		.limit(limit)
		.all();
}

type SessionRow = {
	id: string;
	parentId: string | null;
	title: string | null;
	cwd: string;
	branch: string | null;
	state: SessionState;
	startedAt: Date;
	lastEventAt: Date;
};

type EditCall = { sessionId: string; toolTarget: string | null };

type Catalog = {
	sessions: Map<string, SessionRow>;
	children: Map<string | null, SessionRow[]>;
	summaries: ReturnType<typeof summariesBySession>;
	behind: Set<string>;
	edits: EditCall[];
};

type Placement = {
	depth: number;
	under: string | null;
	callers: Set<string>;
	edited: string[];
};

type ListFilter = {
	isListed(session: SessionRow): boolean;
	callers: Set<string>;
	all: boolean;
};

type Callers = { ids: Set<string>; warnings: string[] };

const OPTIONS = {
	days: { type: "string", default: "7" },
	all: { type: "boolean" },
	session: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const LIST_FIELDS = [
	["progress", "progress"],
	["tried", "tried"],
	["next", "next"],
	["blockers", "blockers"],
] as const;

const EDITED_LABEL = "edited in the last 30m";

const EDIT_WINDOW_MS = 30 * 60_000;

// fact: Claude Code edits files with its Edit, MultiEdit, Write and NotebookEdit tools.
const EDIT_TOOLS = [
	"Edit",
	"MultiEdit",
	"Write",
	"NotebookEdit",
	"apply_patch",
];

const STATE_TONES = {
	busy: "running",
	waiting: "blocked",
	idle: "finished",
	ended: "muted",
} as const;

const RECENT_TOOL_CALLS = 20;

const MAX_TARGET_CHARS = 300;

const MAX_PROCESS_HOPS = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

const PS_LINE = /^(\d+)\s+(.+)$/;

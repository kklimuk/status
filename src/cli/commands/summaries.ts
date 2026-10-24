import type { App } from "@src/app";
import {
	type Catalog,
	type CatalogSession,
	callerSessionIds,
	filesEditedBy,
	type ListedSession,
	listSessions,
	onlyMatch,
	RECENT_TOOL_CALLS,
	readCatalog,
	recentToolCalls,
	sessionsMatching,
} from "@src/summaries";
import { colorize, pluralize, STATE_TONES, type Tone } from "@src/utils";
import { parseArgs } from "util";
import {
	type CommandHelp,
	type CommandResult,
	DAYS_OPTION,
	DEFAULT_DAYS,
	failure,
	help,
	parseDays,
	type Refresh,
	refresh,
	reportTotal,
	shortenHome,
	usage,
} from "../utils";

export async function summariesList(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseListOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(SUMMARIES_LIST.synopsis));
	}
	if (options.help) {
		return { output: help(SUMMARIES_LIST), exitCode: 0 };
	}
	const { days } = options;
	const app = openApp();
	const startedAt = app.now();
	const refreshed = await refresh(app, days);
	const catalog = readCatalog(app);
	const callers = await callerSessionIds(app);
	const since = new Date(app.now().getTime() - days * DAY_MS);
	const filter = { callers: callers.ids, all: options.all === true, since };
	const listed = listSessions(catalog, filter);
	reportTotal(app, startedAt, { Haiku: refreshed.haiku }, refreshed.failed);
	return finish(
		renderList(app, catalog, listed, filter),
		refreshed,
		callers.warnings,
	);
}

export async function summariesGet(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseGetOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(SUMMARIES_GET.synopsis));
	}
	if (options.values.help) {
		return { output: help(SUMMARIES_GET), exitCode: 0 };
	}
	const [sessionId] = options.positionals;
	if (options.positionals.length !== 1 || !sessionId) {
		return failure(
			`summaries get needs one session id; got ${pluralize(options.positionals.length, "argument")}`,
			usage(SUMMARIES_GET.synopsis),
		);
	}
	const app = openApp();
	const startedAt = app.now();
	let matches: CatalogSession[] = [];
	const refreshed = await refresh(app, DEFAULT_DAYS, () => {
		matches = sessionsMatching(app.database, sessionId);
		return { sessionId: onlyMatch(matches)?.id ?? sessionId };
	});
	const catalog = readCatalog(app);
	const match = onlyMatch(matches);
	const session = match ? catalog.sessions.get(match.id) : undefined;
	reportTotal(
		app,
		startedAt,
		{ Haiku: refreshed.haiku },
		refreshed.failed || !session,
	);
	if (session) {
		return finish(renderSession(app, catalog, session), refreshed);
	}
	if (matches.length === 0) {
		const unknown = failure(`unknown session "${sessionId}"`);
		return { ...finish(unknown.output, refreshed), exitCode: 1 };
	}
	const candidates = matches.map(
		(candidate) => `  ${candidate.id}  ${candidate.title ?? "untitled"}`,
	);
	const ambiguous = failure(
		`"${sessionId}" matches ${matches.length} sessions; give more of the id:\n${candidates.join("\n")}`,
	);
	return { ...finish(ambiguous.output, refreshed), exitCode: 1 };
}

function parseListOptions(args: string[]) {
	try {
		const { values } = parseArgs({ args, options: LIST_OPTIONS, strict: true });
		return { ...values, days: parseDays(values.days) };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function parseGetOptions(args: string[]) {
	try {
		return parseArgs({
			args,
			options: GET_OPTIONS,
			strict: true,
			allowPositionals: true,
		});
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
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

function renderSession(app: App, catalog: Catalog, session: CatalogSession) {
	const edited = filesEditedBy(catalog, session.id);
	const lines = renderEntry(app, catalog, session, edited);
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

function renderEntry(
	app: App,
	catalog: Catalog,
	session: CatalogSession,
	edited: string[],
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
	if (session.parentId !== null) {
		field("parent", session.parentId);
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
	lines.push(...listField(EDITED_LABEL, edited));
	return lines;
}

function headline(app: App, catalog: Catalog, session: CatalogSession): string {
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

function collapseSpaces(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function renderList(
	app: App,
	catalog: Catalog,
	listed: ListedSession[],
	filter: { callers: Set<string>; all: boolean },
): string {
	const heading = listHeading(listed.length, filter);
	if (listed.length === 0) {
		return heading;
	}
	const isTerminal = app.outputColumns !== null;
	const shortIds = isTerminal
		? shortestUniqueIds([...catalog.sessions.keys()])
		: null;
	const rows = listed.map(({ session, depth, edited }) => {
		const id = shortIds?.get(session.id) ?? session.id;
		return tableRow(app, catalog, session, {
			id,
			depth,
			edited: edited.length,
			isTerminal,
		});
	});
	return [heading, "", ...renderTable(rows, app.outputColumns)].join("\n");
}

function listHeading(
	count: number,
	filter: { callers: Set<string>; all: boolean },
): string {
	const noun = count === 1 ? "session" : "sessions";
	const scope = filter.all ? `${count} ${noun}` : `${count} live ${noun}`;
	if (filter.callers.size === 0) {
		return colorize(scope, "heading");
	}
	const callers = [...filter.callers].join(", ");
	return colorize(`${scope}, leaving out this session: ${callers}`, "heading");
}

function tableRow(
	app: App,
	catalog: Catalog,
	session: CatalogSession,
	row: { id: string; depth: number; edited: number; isTerminal: boolean },
): Cell[] {
	const directory = shortenHome(session.cwd);
	const objective =
		catalog.summaries.get(session.id)?.objective ?? session.title ?? "";
	const active = age(app.now(), session.lastEventAt);
	return [
		{ text: treeId(session, row.id, row.depth) },
		{ text: session.state, tone: STATE_TONES[session.state] },
		{ text: row.isTerminal ? active.replace(/ ago$/, "") : active },
		waitingCell(catalog, session),
		{ text: String(row.edited) },
		{ text: session.branch ? `${directory} (${session.branch})` : directory },
		{ text: collapseSpaces(objective) },
	];
}

function treeId(session: CatalogSession, id: string, depth: number): string {
	if (depth > 0) {
		return `${"  ".repeat(depth - 1)}└ ${id}`;
	}
	return session.parentId === null ? id : `↑ ${id}`;
}

function shortestUniqueIds(ids: string[]): Map<string, string> {
	const sorted = [...ids].sort();
	return new Map(
		sorted.map((id, index) => {
			const neighbors = [sorted[index - 1], sorted[index + 1]];
			const shared = Math.max(
				0,
				...neighbors.map((other) => sharedPrefixLength(id, other ?? "")),
			);
			const harnessLength = id.indexOf(":") + 1;
			const length = Math.max(harnessLength + SHORT_ID_CHARS, shared + 1);
			return [id, id.slice(0, length)];
		}),
	);
}

function sharedPrefixLength(left: string, right: string): number {
	let length = 0;
	while (length < left.length && left[length] === right[length]) {
		length += 1;
	}
	return length;
}

function waitingCell(catalog: Catalog, session: CatalogSession): Cell {
	const summary = catalog.summaries.get(session.id);
	if (!summary) {
		return { text: "no summary", tone: "blocked" };
	}
	if (catalog.behind.has(session.id)) {
		return { text: "behind", tone: "blocked" };
	}
	return { text: summary.waitingOn, tone: WAITING_TONES[summary.waitingOn] };
}

function renderTable(rows: Cell[][], columns: number | null): string[] {
	const headings = TABLE_HEADINGS.map((text) => ({
		text,
		tone: "heading" as const,
	}));
	const table = [headings, ...rows];
	const widths = headings.map((_, index) =>
		Math.max(...table.map((row) => Bun.stringWidth(row[index]?.text ?? ""))),
	);
	const fixed = widths
		.slice(0, -1)
		.reduce((sum, width) => sum + width + COLUMN_GAP.length, 0);
	const room = Math.max(
		MIN_OBJECTIVE_WIDTH,
		(columns ?? Number.POSITIVE_INFINITY) - fixed,
	);
	return table.map((row) =>
		row
			.map((cell, index) => {
				const isLast = index === row.length - 1;
				const width = widths[index] ?? 0;
				const text = isLast ? fit(cell.text, room) : padEnd(cell.text, width);
				return cell.tone ? colorize(text, cell.tone) : text;
			})
			.join(COLUMN_GAP),
	);
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
}

function fit(text: string, room: number): string {
	if (Bun.stringWidth(text) <= room) {
		return text;
	}
	let kept = "";
	for (const { segment } of new Intl.Segmenter().segment(text)) {
		if (Bun.stringWidth(kept + segment) > room - 1) {
			break;
		}
		kept += segment;
	}
	return `${kept.trimEnd()}…`;
}

type Cell = { text: string; tone?: Tone };

export const SUMMARIES_LIST: CommandHelp = {
	name: "summaries list",
	synopsis: "status summaries list [--days <n>] [--all]",
	about:
		"List the live sessions and their summaries, for agents to read before they act.",
	details:
		"One row per session: ID (subagents as a tree), STATE, ACTIVE, WAITING, EDITS (files edited in the last 30 minutes), DIR and OBJECTIVE, cut to the terminal's width and printed in full when piped. It leaves out the session that runs it. Drill into a row with status summaries get <id>.",
	options: [
		DAYS_OPTION,
		["--all", "add ended sessions whose last event is in the window"],
	],
};

export const SUMMARIES_GET: CommandHelp = {
	name: "summaries get",
	synopsis: "status summaries get <session_id>",
	about: "Bring one session's summary up to date and show it in full.",
	details:
		"Refreshes that session and its subagents, even when it's busy, then shows its whole summary (progress, tried, next, blockers, the ask), the files it edited in the last 30 minutes, its parent, its subagents and its last 20 tool calls. Takes any id another command printed, whatever its state.",
	options: [],
};

const LIST_OPTIONS = {
	days: { type: "string", default: String(DEFAULT_DAYS) },
	all: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

const GET_OPTIONS = {
	help: { type: "boolean", short: "h" },
} as const;

const LIST_FIELDS = [
	["progress", "progress"],
	["tried", "tried"],
	["next", "next"],
	["blockers", "blockers"],
] as const;

const EDITED_LABEL = "edited in the last 30m";

const TABLE_HEADINGS = [
	"ID",
	"STATE",
	"ACTIVE",
	"WAITING",
	"EDITS",
	"DIR",
	"OBJECTIVE",
] as const;

const COLUMN_GAP = "  ";

const SHORT_ID_CHARS = 8;

const MIN_OBJECTIVE_WIDTH = 20;

const WAITING_TONES = {
	user: "blocked",
	external: "running",
	none: "muted",
} as const satisfies Record<string, Tone>;

const MAX_TARGET_CHARS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

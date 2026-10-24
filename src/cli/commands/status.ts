import type { App } from "@src/app";
import { type StatusDatabase, sessions } from "@src/database";
import {
	type Answer,
	answerQuestion,
	type Brief,
	formatAge,
	type Goal,
	rootsInWindow,
	STATUSES,
	type Status,
	type StatusRoot,
	writeBrief,
} from "@src/statuses";
import { colorize, formatDuration, pluralize, type Tone } from "@src/utils";
import { parseArgs } from "util";
import {
	type CommandHelp,
	type CommandResult,
	DAYS_OPTION,
	DEFAULT_DAYS,
	failure,
	help,
	parseDays,
	refresh,
	reportTotal,
	shortenHome,
	usage,
} from "../utils";

export async function statusList(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args, false);
	if (options instanceof Error) {
		return failure(options.message, usage(STATUS_LIST.synopsis));
	}
	if (options.help) {
		return { output: help(STATUS_LIST), exitCode: 0 };
	}
	const app = openApp();
	const startedAt = app.now();
	const window = await triageWindow(app, options.days);
	if (window.roots.length === 0) {
		reportTotal(app, startedAt, { Haiku: window.haiku }, window.failed);
		return finish(window.empty, window.issues, window.failed);
	}

	const brief = await judged(
		app,
		`brief ${pluralize(window.roots.length, "session")} by goal`,
		() => writeBrief(app, window.roots, window.now),
	);
	const output = renderBrief(brief, options.days, {
		names: shortIds(brief.goals, storedSessionIds(app.database)),
		now: window.now,
		width: app.outputColumns ?? PIPED_COLUMNS,
	});
	const failed = window.failed || brief.failure !== null;
	reportTotal(
		app,
		startedAt,
		{ Haiku: window.haiku, Opus: brief.opus },
		failed,
	);
	return finish(output, [...window.issues, ...briefIssues(brief)], failed);
}

export async function statusGet(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args, true);
	if (options instanceof Error) {
		return failure(options.message, usage(STATUS_GET.synopsis));
	}
	if (options.help) {
		return { output: help(STATUS_GET), exitCode: 0 };
	}
	const [question = ""] = options.positionals;
	if (options.positionals.length !== 1) {
		return failure(
			`get needs one question, quoted as one argument; got ${pluralize(options.positionals.length, "argument")}`,
			usage(STATUS_GET.synopsis),
		);
	}
	if (question.trim() === "") {
		return failure(
			"get needs a question; got a blank one",
			usage(STATUS_GET.synopsis),
		);
	}
	const app = openApp();
	const startedAt = app.now();
	const window = await triageWindow(app, options.days);
	if (window.roots.length === 0) {
		reportTotal(app, startedAt, { Haiku: window.haiku }, window.failed);
		return finish(window.empty, window.issues, window.failed);
	}

	const answered = await judged(
		app,
		`answer "${question.trim()}" over ${pluralize(window.roots.length, "session")}`,
		() => answerQuestion(app, window.roots, question.trim(), window.now),
	);
	const failed = window.failed || answered.failure !== null;
	reportTotal(
		app,
		startedAt,
		{ Haiku: window.haiku, Opus: answered.opus },
		failed,
	);
	return finish(renderAnswer(answered, window.now), window.issues, failed);
}

function parseOptions(args: string[], allowPositionals: boolean) {
	try {
		const { values, positionals } = parseArgs({
			args,
			options: OPTIONS,
			strict: true,
			allowPositionals,
		});
		return { ...values, positionals, days: parseDays(values.days) };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

async function triageWindow(app: App, days: number) {
	const refreshed = await refresh(app, days);
	const now = app.now();
	const since = new Date(now.getTime() - days * DAY_MS);
	return {
		now,
		roots: rootsInWindow(app.database, since),
		haiku: refreshed.haiku,
		failed: refreshed.failed,
		issues: refreshed.issues ? [refreshed.issues] : [],
		empty: `No sessions in the last ${pluralize(days, "day")}.`,
	};
}

async function judged<
	Result extends { failure: string | null; opus: { inputTokens: number } },
>(app: App, task: string, call: () => Promise<Result>): Promise<Result> {
	app.progress("judge", `asking Opus to ${task}`);
	const startedAt = app.now();
	const result = await call();
	const took = formatDuration(startedAt, app.now());
	if (result.failure !== null) {
		app.progress(
			"judge",
			`${colorize("failed", "error")} after ${took}: ${result.failure}`,
		);
		return result;
	}
	const tokens = result.opus.inputTokens.toLocaleString("en-US");
	app.progress(
		"judge",
		`${colorize("answered", "finished")} in ${took}, ${tokens} input tokens`,
	);
	return result;
}

function briefIssues(brief: Brief): string[] {
	if (brief.failure !== null) {
		return [
			`${colorize("failed:", "error")} writing the brief: ${brief.failure}`,
		];
	}
	if (brief.ungrouped.length === 0) {
		return [];
	}
	const ids = brief.ungrouped.map((root) => root.session.id).join(", ");
	return [
		`${colorize("warning:", "muted")} the brief left out ${ids}, shown under ${UNGROUPED_HEADING}`,
	];
}

function renderAnswer(answered: Answer, now: Date): string {
	if (answered.failure !== null) {
		return `${colorize("failed:", "error")} answering the question: ${answered.failure}`;
	}
	if (answered.sessions.length === 0) {
		return answered.answer;
	}
	return [
		answered.answer,
		"",
		colorize("sessions:", "heading"),
		...answered.sessions.map((root) => `  ${headline(root, now)}`),
	].join("\n");
}

function renderBrief(brief: Brief, days: number, layout: Layout): string {
	const sections = STATUSES.flatMap((status) => {
		const goals = brief.goals.filter((goal) => goal.status === status);
		if (goals.length === 0) {
			return [];
		}
		const heading = colorize(STATUS_HEADINGS[status], STATUS_TONES[status]);
		if (status === "finished") {
			const lines = goals.map((goal) => renderFinishedGoal(goal, layout));
			return [`${heading}\n${lines.join("\n")}`];
		}
		const blocks = goals.map((goal, index) =>
			renderGoal(goal, index + 1, layout),
		);
		return [`${heading}\n${blocks.join("\n\n")}`];
	});
	if (brief.ungrouped.length > 0) {
		const body = brief.ungrouped
			.map((item) => renderUngrouped(item, layout))
			.join("\n\n");
		sections.push(`${colorize(UNGROUPED_HEADING, "muted")}\n${body}`);
	}
	return [renderTally(brief, days), ...sections].join("\n\n");
}

function renderTally(brief: Brief, days: number): string {
	const parts = [`Last ${pluralize(days, "day")}`];
	if (brief.goals.length > 0) {
		const count = (status: Status) =>
			brief.goals.filter((goal) => goal.status === status).length;
		const needYou = count("needs_you");
		parts.push(
			colorize(
				`${pluralize(needYou, "goal")} ${needYou === 1 ? "needs" : "need"} you`,
				"blocked",
			),
			colorize(`${count("running")} running`, "running"),
			colorize(`${count("finished")} finished`, "finished"),
		);
	}
	if (brief.ungrouped.length > 0) {
		parts.push(`${pluralize(brief.ungrouped.length, "session")} not grouped`);
	}
	return parts.join(" · ");
}

function renderGoal(
	goal: Goal,
	position: number,
	{ names, now, width }: Layout,
): string {
	const fields: [string, string[]][] = [
		["Goal:", wrap(goal.goal, width - GOAL_INDENT - LABEL_WIDTH)],
		["Done:", renderItems(goal.done, "bullet", width)],
		["Blockers:", renderItems(goal.blockers, "bullet", width)],
		[
			goal.status === "running" ? "Now:" : "Next:",
			renderItems(goal.next, "numbered", width),
		],
	];
	const indent = " ".repeat(GOAL_INDENT);
	const lines = [colorize(`${position}. ${goal.name}`, "heading")];
	for (const [label, body] of fields) {
		for (const [index, line] of body.entries()) {
			const prefix = index === 0 ? label : "";
			lines.push(`${indent}${prefix.padEnd(LABEL_WIDTH)}${line}`);
		}
	}
	lines.push(
		...goal.sessions.map((item) => `${indent}${footnote(item, names, now)}`),
	);
	return lines.join("\n");
}

function renderItems(
	items: string[],
	style: "bullet" | "numbered",
	width: number,
): string[] {
	return items.flatMap((item, index) => {
		const marker = style === "bullet" ? "- " : `${index + 1}. `;
		const hanging = " ".repeat(marker.length);
		const room = width - GOAL_INDENT - LABEL_WIDTH - marker.length;
		return wrap(item, room).map((line, lineIndex) => {
			const lead = lineIndex === 0 ? marker : hanging;
			return `${lead}${line}`;
		});
	});
}

function renderFinishedGoal(goal: Goal, { names, width }: Layout): string {
	const result = goal.done.join("; ") || goal.goal;
	const text = `${goal.name}: ${result}`;
	const ids = goal.sessions
		.map((item) => names.get(item.session.id) ?? item.session.id)
		.join(", ");
	const lines = wrap(text, width - 2).map((line, index) =>
		index === 0 ? `- ${line}` : `  ${line}`,
	);
	const idLines = wrap(ids, width - 4).map((line, index) =>
		colorize(index === 0 ? `  ↳ ${line}` : `    ${line}`, "muted"),
	);
	return [...lines, ...idLines].join("\n");
}

function renderUngrouped(item: StatusRoot, { now, width }: Layout): string {
	const objective =
		item.summary?.objective ?? item.session.title ?? "no summary yet";
	const lines = [
		`- ${headline(item, now)}`,
		...indentWrapped(objective, width),
	];
	const ask = askOf(item);
	if (ask) {
		lines.push(
			...indentWrapped(`ask: ${ask}`, width).map((line) =>
				colorize(line, "blocked"),
			),
		);
	}
	return lines.join("\n");
}

function indentWrapped(text: string, width: number): string[] {
	return text
		.split("\n")
		.filter((paragraph) => paragraph.trim() !== "")
		.flatMap((paragraph) => wrap(paragraph, width - 2))
		.map((line) => `  ${line}`);
}

function askOf(item: StatusRoot): string | null {
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

function footnote(
	item: StatusRoot,
	names: Map<string, string>,
	now: Date,
): string {
	const details = [
		`${item.session.state} ${formatAge(item.lastActiveAt, now)}`,
	];
	if (item.liveSubagents.length > 0) {
		details.push(`+ ${pluralize(item.liveSubagents.length, "agent")}`);
	}
	if (item.summary === null) {
		details.push("no summary");
	} else if (item.behind) {
		details.push("summary behind");
	}
	const name = names.get(item.session.id) ?? item.session.id;
	return colorize(`↳ ${name} · ${details.join(" · ")}`, "muted");
}

function shortIds(goals: Goal[], storedIds: string[]): Map<string, string> {
	const ids = goals.flatMap((goal) =>
		goal.sessions.map((item) => item.session.id),
	);
	return new Map(
		ids.map((id) => {
			const start = id.indexOf(":") + 1;
			let length = SHORT_ID_CHARS;
			while (
				start + length < id.length &&
				storedIds.some(
					(other) =>
						other !== id && other.startsWith(id.slice(0, start + length)),
				)
			) {
				length += 1;
			}
			return [id, id.slice(0, start + length)];
		}),
	);
}

function wrap(text: string, width: number): string[] {
	const room = Math.max(width, MIN_WRAP_COLUMNS);
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter((part) => part !== "")) {
		if (line === "") {
			line = word;
		} else if (Bun.stringWidth(`${line} ${word}`) <= room) {
			line = `${line} ${word}`;
		} else {
			lines.push(line);
			line = word;
		}
	}
	return line === "" ? lines : [...lines, line];
}

function headline(item: StatusRoot, now: Date): string {
	const { session } = item;
	const directory = shortenHome(session.cwd);
	const place = session.branch ? `${directory} (${session.branch})` : directory;
	const details = [session.state, place, formatAge(item.lastActiveAt, now)];
	if (item.summary === null) {
		details.push("no summary");
	} else if (item.behind) {
		details.push("summary behind");
	}
	return `${session.id}  ${colorize(details.join(" · "), "muted")}`;
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

function storedSessionIds(database: StatusDatabase): string[] {
	return database
		.select({ id: sessions.id })
		.from(sessions)
		.all()
		.map((row) => row.id);
}

type Layout = { names: Map<string, string>; now: Date; width: number };

export const STATUS_LIST: CommandHelp = {
	name: "list",
	synopsis: "status list [--days <n>]",
	about:
		"A daily brief of the sessions active in the window, by goal: what each goal is, what was done, its blockers and what to do next.",
	details:
		"Syncs, brings the summaries up to date, then asks Opus to group the root sessions into goals and write each one up: needs you (numbered in the order to take them), running, or finished (one line each). Exits 1 when a sync, a summary or the brief failed, after printing what it has.",
	options: [DAYS_OPTION],
};

export const STATUS_GET: CommandHelp = {
	name: "get",
	synopsis: "status get <question> [--days <n>]",
	about:
		"Ask Opus one question about the sessions active in the window; prints its answer and the sessions it relied on.",
	details:
		"Quote the question as one argument: status get \"what's blocked on me in lamplighter?\". Opus reads the same input as list: each root session's live state, directory, branch, activity, live subagents and summary.",
	options: [DAYS_OPTION],
};

const OPTIONS = {
	days: { type: "string", default: String(DEFAULT_DAYS) },
	help: { type: "boolean", short: "h" },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_HEADINGS: Record<Status, string> = {
	needs_you: "NEEDS YOU",
	running: "RUNNING",
	finished: "FINISHED",
};

const STATUS_TONES: Record<Status, Tone> = {
	needs_you: "blocked",
	running: "running",
	finished: "finished",
};

const UNGROUPED_HEADING = "NOT GROUPED";

const PIPED_COLUMNS = 100;

const MIN_WRAP_COLUMNS = 30;

const GOAL_INDENT = 3;

const SHORT_ID_CHARS = 8;

const LABEL_WIDTH = "Blockers: ".length;

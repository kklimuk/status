import type { App } from "@src/app";
import {
	type RefreshScope,
	refreshSummaries,
	type SummaryIssue,
} from "@src/summaries";
import { type SyncIssue, sync } from "@src/sync";
import { colorize, formatDuration, pluralize } from "@src/utils";
import { homedir } from "os";

export function help(...commands: CommandHelp[]): string {
	const synopses = usage(...commands.map((command) => command.synopsis));
	const [only] = commands;
	if (commands.length === 1 && only) {
		const options = table([...only.options, HELP_OPTION]);
		return [synopses, `${only.about} ${only.details}`, options].join("\n\n");
	}
	const verbs = table(commands.map((command) => [command.name, command.about]));
	return [synopses, verbs, "Run a command with --help for its options."].join(
		"\n\n",
	);
}

export function usage(...synopses: string[]): string {
	const label = colorize("usage:", "heading");
	return synopses
		.map((synopsis, index) =>
			index === 0 ? `${label} ${synopsis}` : `       ${synopsis}`,
		)
		.join("\n");
}

export function failure(reason: string, usageText?: string): CommandResult {
	const message = `${colorize("status:", "error")} ${reason}`;
	return {
		output: usageText ? `${message}\n\n${usageText}` : message,
		exitCode: 1,
	};
}

export function parseDays(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) === 0 || Number(value) > MAX_DAYS) {
		throw new Error(
			`--days takes a whole number from 1 to ${MAX_DAYS}, not "${value}"`,
		);
	}
	return Number(value);
}

export async function refresh(
	app: App,
	days: number,
	scopeAfterSync: () => RefreshScope = () => ({}),
): Promise<Refresh> {
	const since = new Date(app.now().getTime() - days * DAY_MS);
	const synced = await sync(app, since);
	const summarized = await refreshSummaries(app, scopeAfterSync());
	const failures = [
		...synced.failures.map(describeSyncIssue),
		...summarized.failures.map(describeSummaryIssue),
	];
	const warnings = [
		...synced.warnings.map(describeSyncIssue),
		...summarized.warnings.map(describeSummaryIssue),
	];
	return {
		deferred: new Set(summarized.deferred),
		haiku: {
			calls: summarized.roots.calls + summarized.subagents.calls,
			inputTokens:
				summarized.roots.inputTokens + summarized.subagents.inputTokens,
		},
		failed: failures.length > 0,
		issues: [
			...failures.map((text) => `${colorize("failed:", "error")} ${text}`),
			...warnings.map((text) => `${colorize("warning:", "muted")} ${text}`),
		].join("\n"),
	};
}

export function reportTotal(
	app: App,
	startedAt: Date,
	usages: Record<string, ModelUsage>,
	failed: boolean,
) {
	const parts = Object.entries(usages).map(
		([model, usage]) =>
			`${model} ${pluralize(usage.calls, "call")}, ${usage.inputTokens.toLocaleString("en-US")} input tokens`,
	);
	const result = colorize(
		failed ? "half-finished" : "done",
		failed ? "error" : "finished",
	);
	const took = formatDuration(startedAt, app.now());
	app.progress("total", [`${result} in ${took}`, ...parts].join(" · "));
}

export function shortenHome(path: string): string {
	const home = homedir();
	if (path !== home && !path.startsWith(`${home}/`)) {
		return path;
	}
	return `~${path.slice(home.length)}`;
}

function table(rows: (readonly [string, string])[]): string {
	const width = Math.max(...rows.map(([name]) => name.length));
	return rows
		.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`)
		.join("\n");
}

function describeSyncIssue(issue: SyncIssue): string {
	const source = issue.source ? ` ${issue.source}` : "";
	return `${issue.harness} ${issue.step}${source}: ${issue.message}`;
}

function describeSummaryIssue(issue: SummaryIssue): string {
	return `summary ${issue.sessionId}: ${issue.message}`;
}

export type CommandResult = { output: string; exitCode: number };

export type CommandHelp = {
	name: string;
	synopsis: string;
	about: string;
	details: string;
	options: (readonly [string, string])[];
};

export type Refresh = {
	deferred: Set<string>;
	haiku: ModelUsage;
	failed: boolean;
	issues: string;
};

export type ModelUsage = { calls: number; inputTokens: number };

const MAX_DAYS = 3650;

export const DEFAULT_DAYS = 7;

export const DAYS_OPTION = [
	"--days <n>",
	`the window, in days from 1 to ${MAX_DAYS} (default ${DEFAULT_DAYS})`,
] as const;

const HELP_OPTION = ["-h, --help", "show this help"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

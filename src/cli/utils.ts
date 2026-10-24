import type { App } from "@src/app";
import { refreshSummaries, type SummaryIssue } from "@src/summaries";
import { type SyncIssue, sync } from "@src/sync";

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

export async function refresh(app: App, days: number): Promise<Refresh> {
	const since = new Date(app.now().getTime() - days * DAY_MS);
	const synced = await sync(app, since);
	const summarized = await refreshSummaries(app);
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
		failed: failures.length > 0,
		issues: [
			...failures.map((text) => `${colorize("failed:", "error")} ${text}`),
			...warnings.map((text) => `${colorize("warning:", "muted")} ${text}`),
		].join("\n"),
	};
}

/** @public */
export function colorize(text: string, tone: Tone): string {
	const code = Bun.color(TONES[tone], "ansi");
	return code ? `${code}${text}${RESET}` : text;
}

function describeSyncIssue(issue: SyncIssue): string {
	const source = issue.source ? ` ${issue.source}` : "";
	return `${issue.harness} ${issue.step}${source}: ${issue.message}`;
}

function describeSummaryIssue(issue: SummaryIssue): string {
	return `summary ${issue.sessionId}: ${issue.message}`;
}

export type CommandResult = { output: string; exitCode: number };

export type Refresh = {
	deferred: Set<string>;
	failed: boolean;
	issues: string;
};

type Tone = keyof typeof TONES;

const MAX_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

const TONES = {
	heading: "#3e9eff",
	error: "#e5484d",
	running: "#12a594",
	blocked: "#ffb224",
	finished: "#46a758",
	muted: "#8b8d98",
};

const RESET = "\x1b[0m";

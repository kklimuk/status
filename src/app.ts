import { openDatabase, type StatusDatabase } from "@src/database";
import {
	createClaudeAdapter,
	createCodexAdapter,
	type HarnessAdapter,
} from "@src/harnesses";
import {
	askClaude,
	type ClaudeRequest,
	type ClaudeResponse,
	colorize,
} from "@src/utils";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function createApp(environment: Environment): App {
	const paths = {
		status: environment.STATUS_HOME || defaultStatusHome(CHECKOUT),
		claude: environment.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
		codex: environment.CODEX_HOME || join(homedir(), ".codex"),
	};
	const now = () => new Date();
	return {
		database: openDatabase(join(paths.status, "status.db")),
		paths,
		adapters: [
			createClaudeAdapter(paths.claude),
			createCodexAdapter(paths.codex),
		],
		now,
		progress: progressTo(process.stderr, now),
		outputColumns: process.stdout.isTTY ? process.stdout.columns || null : null,
		askClaude,
	};
}

export function defaultStatusHome(checkout: string): string {
	const gitEntry = join(checkout, ".git");
	const isGitFile = statSync(gitEntry, { throwIfNoEntry: false })?.isFile();
	if (isGitFile && LINKED_WORKTREE.test(readFileSync(gitEntry, "utf8"))) {
		return join(checkout, ".status");
	}
	return join(homedir(), ".status");
}

export function progressTo(
	stream: ProgressStream,
	now: () => Date,
): App["progress"] {
	return (tag, message) => {
		if (!stream.isTTY) {
			return;
		}
		const clock = colorize(localTimestamp(now()), "muted");
		stream.write(`${clock} ${colorize(`[${tag}]`, "heading")} ${message}\n`);
	};
}

function localTimestamp(at: Date): string {
	const offsetMinutes = -at.getTimezoneOffset();
	const local = new Date(+at + offsetMinutes * 60_000).toISOString();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
		2,
		"0",
	);
	const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
	return `${local.slice(0, 19)}${sign}${hours}:${minutes}`;
}

export type App = {
	database: StatusDatabase;
	paths: { status: string; claude: string; codex: string };
	adapters: HarnessAdapter[];
	now(): Date;
	progress(tag: ProgressTag, message: string): void;
	outputColumns: number | null;
	askClaude(request: ClaudeRequest): Promise<ClaudeResponse>;
};

type ProgressTag = "sync" | "summaries" | "judge" | "total";

type ProgressStream = { isTTY?: boolean; write(text: string): unknown };

type Environment = Record<string, string | undefined>;

const CHECKOUT = join(import.meta.dir, "..");

// fact: a linked worktree's .git file reads "gitdir: <git dir>/worktrees/<name>"; a submodule's points into modules/ instead.
const LINKED_WORKTREE = /[\\/]worktrees[\\/][^\\/]+\s*$/;

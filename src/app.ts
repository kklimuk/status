import { openDatabase, type StatusDatabase } from "@src/database";
import {
	createClaudeAdapter,
	createCodexAdapter,
	type HarnessAdapter,
} from "@src/harnesses";
import { askClaude, type ClaudeRequest, type ClaudeResponse } from "@src/utils";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function createApp(environment: Environment): App {
	const paths = {
		status: environment.STATUS_HOME || defaultStatusHome(CHECKOUT),
		claude: environment.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
		codex: environment.CODEX_HOME || join(homedir(), ".codex"),
	};
	return {
		database: openDatabase(join(paths.status, "status.db")),
		paths,
		adapters: [
			createClaudeAdapter(paths.claude),
			createCodexAdapter(paths.codex),
		],
		now: () => new Date(),
		progress,
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

function progress(message: string) {
	if (process.stderr.isTTY) {
		process.stderr.write(`${message}\n`);
	}
}

export type App = {
	database: StatusDatabase;
	paths: { status: string; claude: string; codex: string };
	adapters: HarnessAdapter[];
	now(): Date;
	progress(message: string): void;
	askClaude(request: ClaudeRequest): Promise<ClaudeResponse>;
};

type Environment = Record<string, string | undefined>;

const CHECKOUT = join(import.meta.dir, "..");

// fact: a linked worktree's .git file reads "gitdir: <git dir>/worktrees/<name>"; a submodule's points into modules/ instead.
const LINKED_WORKTREE = /[\\/]worktrees[\\/][^\\/]+\s*$/;

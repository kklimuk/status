import { onTestFinished } from "bun:test";
import { type App, createApp } from "@src/app";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function createTestApp(overrides: Partial<App> = {}): App {
	const home = createTemporaryHome();
	const app = createApp(home.environment);
	onTestFinished(() => app.database.$client.close());
	return {
		...app,
		progress: () => {},
		outputColumns: null,
		askClaude: rejectUnexpectedCall,
		...overrides,
	};
}

export function createTemporaryHome() {
	const root = mkdtempSync(join(tmpdir(), "status-test-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const status = join(root, ".status");
	const claude = join(root, ".claude");
	const codex = join(root, ".codex");
	for (const directory of [status, claude, codex]) {
		mkdirSync(directory);
	}
	return {
		status,
		claude,
		codex,
		environment: {
			STATUS_HOME: status,
			CLAUDE_CONFIG_DIR: claude,
			CODEX_HOME: codex,
		},
	};
}

async function rejectUnexpectedCall(): Promise<never> {
	throw new Error(
		"askClaude was called without a fake: pass one to createTestApp",
	);
}

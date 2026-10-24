import { expect, onTestFinished, test } from "bun:test";
import { createApp, defaultStatusHome, progressTo } from "@src/app";
import { createTemporaryHome } from "@tests/utils";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

test("code running from a linked worktree keeps its database inside that worktree", async () => {
	const worktree = createCheckout();
	await Bun.write(
		join(worktree, ".git"),
		"gitdir: /elsewhere/.git/worktrees/x\n",
	);

	expect(defaultStatusHome(worktree)).toBe(join(worktree, ".status"));
});

test("code running from a submodule checkout uses ~/.status", async () => {
	const submodule = createCheckout();
	await Bun.write(join(submodule, ".git"), "gitdir: ../.git/modules/status\n");

	expect(defaultStatusHome(submodule)).toBe(join(homedir(), ".status"));
});

test("code running from the main checkout uses ~/.status", () => {
	const checkout = createCheckout();
	mkdirSync(join(checkout, ".git"));

	expect(defaultStatusHome(checkout)).toBe(join(homedir(), ".status"));
});

test("createApp takes every home from the environment and opens status.db there", () => {
	const home = createTemporaryHome();

	const app = createApp(home.environment);
	onTestFinished(() => app.database.$client.close());

	expect(app.paths).toEqual({
		status: home.status,
		claude: home.claude,
		codex: home.codex,
	});
	expect(app.database.$client.filename).toBe(join(home.status, "status.db"));
	expect(app.adapters.map((adapter) => adapter.harness)).toEqual([
		"claude",
		"codex",
	]);
});

test("progress writes a line stamped with local ISO 8601 time and its offset, then the tag, to a terminal", () => {
	const savedZone = process.env.TZ;
	onTestFinished(() => {
		process.env.TZ = savedZone;
	});
	const terminal = fakeStream(true);
	const at = new Date("2026-10-24T17:42:07.900Z");

	process.env.TZ = "America/Los_Angeles";
	progressTo(terminal, () => at)("sync", "claude: reading 3 sources");
	process.env.TZ = "Asia/Kolkata";
	progressTo(terminal, () => at)("judge", "answered");
	process.env.TZ = "UTC";
	progressTo(terminal, () => at)("total", "done");

	expect(terminal.written.map((line) => Bun.stripANSI(line))).toEqual([
		"2026-10-24T10:42:07-07:00 [sync] claude: reading 3 sources\n",
		"2026-10-24T23:12:07+05:30 [judge] answered\n",
		"2026-10-24T17:42:07+00:00 [total] done\n",
	]);
});

test("progress writes nothing when stderr isn't a terminal, so an agent or a pipe gets only the output", () => {
	const pipe = fakeStream(false);
	const progress = progressTo(pipe, () => new Date());

	progress("summaries", "started 1/1 claude:abc");
	progress("judge", "asking Opus to group 1 session by goal");

	expect(pipe.written).toEqual([]);
});

function fakeStream(isTTY: boolean) {
	const written: string[] = [];
	return { isTTY, written, write: (text: string) => written.push(text) };
}

function createCheckout() {
	const checkout = mkdtempSync(join(tmpdir(), "status-checkout-"));
	onTestFinished(() => rmSync(checkout, { recursive: true, force: true }));
	return checkout;
}

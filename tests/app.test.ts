import { expect, onTestFinished, test } from "bun:test";
import { createApp, defaultStatusHome } from "@src/app";
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

function createCheckout() {
	const checkout = mkdtempSync(join(tmpdir(), "status-checkout-"));
	onTestFinished(() => rmSync(checkout, { recursive: true, force: true }));
	return checkout;
}

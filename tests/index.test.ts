import { expect, test } from "bun:test";
import { createTemporaryHome } from "@tests/utils";

test("--help prints plain usage when piped and exits zero", async () => {
	const result = await runStatus(["--help"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toStartWith("usage: status list [");
	expect(result.stdout).not.toContain(ESCAPE);
	expect(result.stderr).toBe("");
});

test("an unknown command fails closed on stderr", async () => {
	const result = await runStatus(["bogus"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toStartWith('status: unknown command "bogus"');
});

test("an unknown option fails closed on stderr", async () => {
	const result = await runStatus(["list", "--bogus"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("--bogus");
	expect(result.stderr).not.toContain(ESCAPE);
});

test("a piped run writes no progress log, only its output", async () => {
	const list = await runStatus(["summaries", "list"]);
	const unknown = await runStatus(["summaries", "get", "claude:nope"]);

	expect(list.exitCode).toBe(0);
	expect(list.stdout).toBe("0 live sessions\n");
	expect(list.stderr).toBe("");
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stdout).toBe("");
	expect(unknown.stderr).toBe('status: unknown session "claude:nope"\n');
});

async function runStatus(args: string[]) {
	const home = createTemporaryHome();
	const { CODEX_THREAD_ID: _callerThread, ...environment } = process.env;
	const child = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: { ...environment, ...home.environment, FORCE_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

const ENTRY = `${import.meta.dir}/../src/index.ts`;

const ESCAPE = "\x1b[";

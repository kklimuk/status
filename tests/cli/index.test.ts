import { expect, test } from "bun:test";
import { run } from "@src/cli";

test("`status --help` lists both commands without opening the app", async () => {
	const result = await run(["--help"], refuseToOpen);

	expect(result.exitCode).toBe(0);
	expect(plain(result)).toStartWith("usage: status [");
	expect(plain(result)).toContain("\n       status summaries [");
});

test("`status summaries --help` shows its own usage without opening the app", async () => {
	const result = await run(["summaries", "--help"], refuseToOpen);

	expect(result.exitCode).toBe(0);
	expect(plain(result)).toStartWith("usage: status summaries [");
});

test("an unknown command fails closed with the usage", async () => {
	const result = await run(["bogus"], refuseToOpen);

	expect(result.exitCode).toBe(1);
	expect(plain(result)).toStartWith(
		'status: unknown command "bogus"\n\nusage:',
	);
	expect(plain(result)).toContain("status summaries [");
});

test("an unknown option fails closed with that command's usage", async () => {
	const statusResult = await run(["--bogus"], refuseToOpen);
	const summariesResult = await run(["summaries", "--bogus"], refuseToOpen);

	expect(statusResult.exitCode).toBe(1);
	expect(plain(statusResult)).toContain("--bogus");
	expect(plain(statusResult)).not.toContain("summaries");
	expect(summariesResult.exitCode).toBe(1);
	expect(plain(summariesResult)).toContain("--bogus");
	expect(plain(summariesResult)).toContain("usage: status summaries [");
});

test("a stray argument or a bad --days fails closed", async () => {
	for (const args of [
		["--days", "3", "summaries"],
		["--days", "0"],
		["summaries", "--days", "two"],
	]) {
		const result = await run(args, refuseToOpen);

		expect(result.exitCode).toBe(1);
		expect(plain(result)).not.toContain(OPENED);
	}
});

test("each command opens the app once its options parse", async () => {
	for (const args of [
		[],
		["--days", "3"],
		["summaries"],
		["summaries", "--all", "--days", "2"],
		["summaries", "--session", "claude:abc"],
	]) {
		const result = await run(args, refuseToOpen);

		expect(result.exitCode).toBe(1);
		expect(plain(result)).toBe(`status: ${OPENED}`);
	}
});

function refuseToOpen(): never {
	throw new Error(OPENED);
}

function plain(result: { output: string }): string {
	return Bun.stripANSI(result.output);
}

const OPENED = "the command opened the app";

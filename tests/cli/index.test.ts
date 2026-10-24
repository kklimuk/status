import { expect, test } from "bun:test";
import { run } from "@src/cli";

test("a bare `status`, or `status --help`, lists every command without opening the app", async () => {
	for (const args of [[], ["--help"], ["-h"]]) {
		const result = await run(args, refuseToOpen);

		expect(result.exitCode).toBe(0);
		expect(plain(result)).toStartWith(
			[
				"usage: status list [--days <n>]",
				"       status get <question> [--days <n>]",
				"       status summaries list [--days <n>] [--all]",
				"       status summaries get <session_id>",
			].join("\n"),
		);
	}
});

test("a bare `status summaries`, or its --help, lists only its own verbs", async () => {
	for (const args of [["summaries"], ["summaries", "--help"]]) {
		const result = await run(args, refuseToOpen);

		expect(result.exitCode).toBe(0);
		expect(plain(result)).toStartWith(
			"usage: status summaries list [--days <n>] [--all]\n       status summaries get <session_id>\n\n",
		);
	}
});

test("each verb has its own --help, with its options", async () => {
	const cases = [
		[["list", "--help"], "usage: status list [--days <n>]\n\n", "--days <n>"],
		[["get", "-h"], "usage: status get <question>", "--days <n>"],
		[["summaries", "list", "--help"], "usage: status summaries list", "--all"],
		[
			["summaries", "get", "--help"],
			"usage: status summaries get",
			"-h, --help",
		],
	] as const;
	for (const [args, start, option] of cases) {
		const result = await run([...args], refuseToOpen);

		expect(result.exitCode).toBe(0);
		expect(plain(result)).toStartWith(start);
		expect(plain(result)).toContain(`  ${option}`);
	}
});

test("an unknown verb fails closed with its noun's usage", async () => {
	const root = await run(["bogus"], refuseToOpen);
	const summaries = await run(["summaries", "bogus"], refuseToOpen);
	const option = await run(["--days", "3"], refuseToOpen);

	expect(root.exitCode).toBe(1);
	expect(plain(root)).toStartWith(
		'status: unknown command "bogus"\n\nusage: status list',
	);
	expect(plain(root)).toContain("status summaries get <session_id>");
	expect(summaries.exitCode).toBe(1);
	expect(plain(summaries)).toBe(
		'status: unknown command "summaries bogus"\n\nusage: status summaries list [--days <n>] [--all]\n       status summaries get <session_id>',
	);
	expect(option.exitCode).toBe(1);
	expect(plain(option)).toStartWith('status: unknown command "--days"');
});

test("an unknown option fails closed with that verb's usage", async () => {
	const list = await run(["list", "--bogus"], refuseToOpen);
	const summaries = await run(
		["summaries", "list", "--session", "x"],
		refuseToOpen,
	);

	expect(list.exitCode).toBe(1);
	expect(plain(list)).toContain("--bogus");
	expect(plain(list)).toEndWith("\n\nusage: status list [--days <n>]");
	expect(summaries.exitCode).toBe(1);
	expect(plain(summaries)).toContain("--session");
	expect(plain(summaries)).toEndWith(
		"\n\nusage: status summaries list [--days <n>] [--all]",
	);
});

test("a stray argument, a missing one or a bad --days fails closed", async () => {
	for (const args of [
		["list", "summaries"],
		["list", "--days", "0"],
		["list", "--days", "3651"],
		["get"],
		["get", "what", "now"],
		["get", "  "],
		["get", "what now?", "--days", "two"],
		["summaries", "list", "--days", "99999999999999999999"],
		["summaries", "get"],
		["summaries", "get", "claude:a", "claude:b"],
		["summaries", "get", "claude:a", "--days", "3"],
	]) {
		const result = await run(args, refuseToOpen);

		expect(result.exitCode).toBe(1);
		expect(plain(result)).not.toContain(OPENED);
		expect(plain(result)).toContain("\n\nusage: status ");
	}
});

test("each verb opens the app once its arguments parse", async () => {
	for (const args of [
		["list"],
		["list", "--days", "3"],
		["get", "what's blocked on me?"],
		["summaries", "list"],
		["summaries", "list", "--all", "--days", "2"],
		["summaries", "get", "claude:abc"],
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

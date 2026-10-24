import { afterEach, beforeEach, expect, test } from "bun:test";
import type { App } from "@src/app";
import { run } from "@src/cli";
import { events, sessions, summaries } from "@src/database";
import type { SessionState, ToolStatus } from "@src/harnesses";
import { createTestApp } from "@tests/utils";
import { eq } from "drizzle-orm";
import { mkdirSync } from "fs";
import { join } from "path";

let savedThreadId: string | undefined;

beforeEach(() => {
	savedThreadId = process.env.CODEX_THREAD_ID;
	delete process.env.CODEX_THREAD_ID;
});

afterEach(() => {
	if (savedThreadId === undefined) {
		delete process.env.CODEX_THREAD_ID;
	} else {
		process.env.CODEX_THREAD_ID = savedThreadId;
	}
});

test("live sessions are listed with their subagents nested under them, and --all adds ended ones", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "claude:helper", {
		parentId: "claude:root",
		state: "busy",
		startedMinutesAgo: 40,
	});
	addSession(app, "claude:done-helper", {
		parentId: "claude:root",
		state: "ended",
		startedMinutesAgo: 45,
	});
	addSession(app, "codex:other", { state: "waiting", startedMinutesAgo: 10 });
	addSession(app, "codex:old", { state: "ended", startedMinutesAgo: 120 });
	const covered = [
		"claude:helper",
		"claude:done-helper",
		"claude:root",
		"codex:other",
		"codex:old",
	].map((id) => {
		const newest = Math.max(...addEvents(app, id, [message(5)]));
		if (id !== "claude:root") {
			addSummary(app, id, [newest]);
		}
		return newest;
	});
	addSummary(app, "claude:root", covered);

	const live = await runSummaries(app, []);
	const all = await runSummaries(app, ["--all"]);

	expect(live.exitCode).toBe(0);
	expect(headlines(live.output)).toEqual([
		"codex:other  waiting  active 5m ago",
		"claude:root  busy  active 5m ago",
		"    claude:helper  busy  active 5m ago",
	]);
	expect(live.output).toStartWith("3 live sessions\n");
	expect(all.exitCode).toBe(0);
	expect(headlines(all.output)).toEqual([
		"codex:other  waiting  active 5m ago",
		"claude:root  busy  active 5m ago",
		"    claude:helper  busy  active 5m ago",
		"    claude:done-helper  ended  active 5m ago",
		"codex:old  ended  active 5m ago",
	]);
});

test("an entry shows its directory, branch, summary fields one per line, and the ask when it waits on the user", async () => {
	const app = testApp();
	addSession(app, "claude:root", {
		state: "waiting",
		title: "Add the summaries command",
		cwd: "/work/status",
		branch: "stream/2e",
	});
	addSummary(app, "claude:root", addEvents(app, "claude:root", [message(5)]), {
		progress: "Wrote the command\nWrote the tests",
		tried: "",
		waitingOn: "user",
		ask: "Push the branch?\nThe tests pass.",
	});

	const result = await runSummaries(app, []);

	expect(result.output).toBe(
		[
			"1 live session",
			"",
			"claude:root  waiting  active 5m ago",
			"  title: Add the summaries command",
			"  cwd: /work/status",
			"  branch: stream/2e",
			"  objective: Ship it",
			"  outcome: in_progress, waiting on user",
			"  ask: Push the branch?",
			"    The tests pass.",
			"  progress:",
			"    - Wrote the command",
			"    - Wrote the tests",
			"  tried: none",
			"  next: none",
			"  blockers: none",
			"  edited in the last 30m: none",
		].join("\n"),
	);
});

test("the caller's own Claude and Codex sessions are left out, and their subagents move to the top level", async () => {
	const app = testApp();
	await writeOwnPidFile(app, "self");
	process.env.CODEX_THREAD_ID = "thread-self";
	addSession(app, "claude:self", { state: "busy" });
	addSession(app, "claude:sibling", {
		parentId: "claude:self",
		state: "busy",
	});
	addSession(app, "codex:thread-self", { state: "busy" });
	addSession(app, "codex:peer", { state: "idle" });
	for (const id of [
		"claude:self",
		"claude:sibling",
		"codex:thread-self",
		"codex:peer",
	]) {
		addSummary(app, id, addEvents(app, id, [message(5)]));
	}

	const result = await runSummaries(app, ["--all"]);

	expect(headlines(result.output).sort()).toEqual([
		"claude:sibling  busy  active 5m ago",
		"codex:peer  idle  active 5m ago",
	]);
	expect(result.output).toContain("  parent: claude:self (this session)");
	expect(result.output.split("\n")[0]).toContain(
		"leaving out this session: codex:thread-self, claude:self",
	);
});

test("a pid file whose procStart isn't this process's start doesn't make its session the caller", async () => {
	const app = testApp();
	await writeOwnPidFile(app, "stale", {
		procStart: "Thu Jan  1 00:00:00 1970",
	});
	addSession(app, "claude:stale", { state: "busy" });
	addSummary(app, "claude:stale", addEvents(app, "claude:stale", [message(5)]));

	const result = await runSummaries(app, []);

	expect(headlines(result.output)).toEqual([
		"claude:stale  busy  active 5m ago",
	]);
	expect(result.output).not.toContain("leaving out");
});

test("a subagent under a hidden parent shows that parent, and the hidden one's edits go to the entry above it", async () => {
	const app = testApp();
	addSession(app, "codex:root", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "codex:child", {
		parentId: "codex:root",
		state: "ended",
		startedMinutesAgo: 40,
	});
	addSession(app, "codex:grandchild", {
		parentId: "codex:child",
		state: "busy",
		startedMinutesAgo: 30,
	});
	const rootIds = addEvents(app, "codex:root", [
		toolCall("Edit", "/work/root.ts", "ok", 9),
	]);
	const childIds = addEvents(app, "codex:child", [
		toolCall("apply_patch", "/work/child.ts", "ok", 6),
	]);
	const grandchildIds = addEvents(app, "codex:grandchild", [
		toolCall("Write", "/work/grandchild.ts", "ok", 3),
	]);
	addSummary(app, "codex:grandchild", grandchildIds);
	addSummary(app, "codex:child", [...childIds, ...grandchildIds]);
	addSummary(app, "codex:root", [...rootIds, ...childIds, ...grandchildIds]);

	const result = await runSummaries(app, []);

	expect(result.exitCode).toBe(0);
	expect(headlines(result.output)).toEqual([
		"codex:root  busy  active 9m ago",
		"    codex:grandchild  busy  active 3m ago",
	]);
	expect(result.output).toContain(
		[
			"  edited in the last 30m:",
			"    - /work/child.ts",
			"    - /work/root.ts",
			"",
			"    codex:grandchild  busy  active 3m ago",
			"      parent: codex:child",
		].join("\n"),
	);
	expect(result.output).toContain(
		["      edited in the last 30m:", "        - /work/grandchild.ts"].join(
			"\n",
		),
	);
});

test("files edited in the last 30 minutes come from edit tools that weren't refused", async () => {
	const app = testApp();
	addSession(app, "codex:root", { state: "busy" });
	const ids = addEvents(app, "codex:root", [
		toolCall("Edit", "/work/old.ts", "ok", 45),
		toolCall("Write", "/work/new.ts", "ok", 20),
		toolCall("apply_patch", "/work/a.ts\n/work/b.ts", "pending", 10),
		toolCall("Edit", "/work/denied.ts", "user_denied", 9),
		toolCall("Bash", "rm /work/c.ts", "ok", 8),
		toolCall("Edit", "/work/new.ts", "ok", 2),
	]);
	addSummary(app, "codex:root", ids);

	const result = await runSummaries(app, []);

	expect(result.output).toContain(
		[
			"  edited in the last 30m:",
			"    - /work/new.ts",
			"    - /work/a.ts",
			"    - /work/b.ts",
		].join("\n"),
	);
	expect(result.output).not.toContain("old.ts");
	expect(result.output).not.toContain("denied.ts");
	expect(result.output).not.toContain("c.ts");
});

test("a summary is marked behind when a deferred family has moved past it, and a session without one says so", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "claude:helper", {
		parentId: "claude:root",
		state: "busy",
		startedMinutesAgo: 40,
	});
	addSession(app, "claude:fresh", {
		parentId: "claude:root",
		state: "busy",
		startedMinutesAgo: 30,
	});
	addSession(app, "codex:new", { state: "ended", startedMinutesAgo: 20 });
	const rootIds = addEvents(app, "claude:root", [message(9)]);
	const freshIds = addEvents(app, "claude:fresh", [message(8)]);
	addSummary(app, "claude:root", [...rootIds, ...freshIds], {
		updatedMinutesAgo: 5,
	});
	addSummary(app, "claude:fresh", freshIds, { updatedMinutesAgo: 5 });
	addSummary(app, "claude:helper", [], { updatedMinutesAgo: 5 });
	addEvents(app, "claude:helper", [message(1)]);

	const result = await runSummaries(app, ["--all"]);

	expect(result.exitCode).toBe(0);
	expect(headlines(result.output)).toEqual([
		"codex:new  ended  active 20m ago  no summary yet",
		"claude:root  busy  active 9m ago  summary behind",
		"    claude:fresh  busy  active 8m ago",
		"    claude:helper  busy  active 1m ago  summary behind",
	]);
});

test("a failed refresh prints the list, then the failure, marks that summary behind and exits 1", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "idle" });
	const ids = addEvents(app, "claude:root", [message(9)]);
	addSummary(app, "claude:root", ids, { updatedMinutesAgo: 9 });
	addEvents(app, "claude:root", [message(1)]);

	const result = await runSummaries(app, []);

	expect(result.exitCode).toBe(1);
	expect(headlines(result.output)).toEqual([
		"claude:root  idle  active 1m ago  summary behind",
	]);
	expect(result.output).toContain(
		"\n\nfailed: summary claude:root: askClaude was called without a fake",
	);
});

test("--session shows one session in full, with its subagents and its recent tool calls, whatever its state", async () => {
	const app = testApp();
	addSession(app, "codex:root", { state: "ended" });
	addSession(app, "codex:child", {
		parentId: "codex:root",
		state: "ended",
		title: "critic",
	});
	addSession(app, "codex:grandchild", {
		parentId: "codex:child",
		state: "ended",
	});
	const ids = addEvents(app, "codex:root", [
		toolCall("exec_command", "bun test", "error", 3),
		toolCall("apply_patch", "/work/a.ts\n/work/b.ts", "ok", 2),
	]);
	addSummary(app, "codex:root", ids);
	addSummary(app, "codex:child", []);

	const result = await runSummaries(app, ["--session", "codex:root"]);
	const child = await runSummaries(app, ["--session", "codex:grandchild"]);

	expect(result.exitCode).toBe(0);
	expect(result.output).toContain(
		[
			"subagents:",
			"  codex:child  ended  active 1h ago",
			"    critic",
			"    Ship it",
			"    codex:grandchild  ended  active 1h ago  no summary yet",
			"",
			"recent tool calls (last 20):",
			"  2026-10-23 08:57Z  exec_command  error  bun test",
			"  2026-10-23 08:58Z  apply_patch  ok  /work/a.ts, /work/b.ts",
		].join("\n"),
	);
	expect(child.exitCode).toBe(0);
	expect(child.output).toStartWith(
		"codex:grandchild  ended  active 1h ago  no summary yet\n  parent: codex:child",
	);
});

test("an unknown --session id fails closed", async () => {
	const app = testApp();

	const result = await runSummaries(app, ["--session", "claude:nope"]);

	expect(result.exitCode).toBe(1);
	expect(result.output).toBe('status: unknown session "claude:nope"');
});

function testApp(): App {
	return createTestApp({ adapters: [], now: () => NOW });
}

async function runSummaries(app: App, args: string[]) {
	const result = await run(["summaries", ...args], () => app);
	return { ...result, output: Bun.stripANSI(result.output) };
}

function headlines(output: string): string[] {
	return output.split("\n").filter((line) => /^\s*(claude|codex):/.test(line));
}

async function writeOwnPidFile(
	app: App,
	sessionId: string,
	extra: Record<string, unknown> = {},
) {
	const directory = join(app.paths.claude, "sessions");
	mkdirSync(directory, { recursive: true });
	await Bun.write(
		join(directory, `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId,
			kind: "interactive",
			...extra,
		}),
	);
}

function addSession(
	app: App,
	id: string,
	options: {
		parentId?: string;
		state: SessionState;
		title?: string;
		cwd?: string;
		branch?: string;
		startedMinutesAgo?: number;
	},
) {
	const startedAt = minutesAgo(options.startedMinutesAgo ?? 60);
	app.database
		.insert(sessions)
		.values({
			id,
			harness: id.startsWith("codex:") ? "codex" : "claude",
			surface: "unknown",
			parentId: options.parentId ?? null,
			title: options.title ?? null,
			cwd: options.cwd ?? "/work",
			branch: options.branch ?? null,
			state: options.state,
			observedAt: NOW,
			startedAt,
			lastEventAt: startedAt,
			sourcePath: `/sources/${id}`,
			readOffset: 0,
		})
		.run();
}

function addEvents(app: App, sessionId: string, rows: EventFixture[]) {
	const ids = rows.map(
		(row, index) =>
			app.database
				.insert(events)
				.values({ sessionId, key: `${sessionId}:${index}:${+row.at}`, ...row })
				.returning({ id: events.id })
				.get().id,
	);
	const newest = rows.reduce((latest, row) => Math.max(latest, +row.at), 0);
	app.database
		.update(sessions)
		.set({ lastEventAt: new Date(newest) })
		.where(eq(sessions.id, sessionId))
		.run();
	return ids;
}

function addSummary(
	app: App,
	sessionId: string,
	coveredIds: number[],
	fields: SummaryFixture = {},
) {
	const { updatedMinutesAgo, ...rest } = fields;
	app.database
		.insert(summaries)
		.values({
			sessionId,
			throughEventId: Math.max(0, ...coveredIds),
			objective: "Ship it",
			progress: "",
			tried: "",
			next: "",
			blockers: "",
			waitingOn: "none",
			ask: null,
			outcome: "in_progress",
			...rest,
			updatedAt: minutesAgo(updatedMinutesAgo ?? 0),
		})
		.run();
}

function message(minutes: number): EventFixture {
	return {
		at: minutesAgo(minutes),
		role: "assistant",
		text: "Working on it",
	};
}

function toolCall(
	toolName: string,
	toolTarget: string,
	toolStatus: ToolStatus,
	minutes: number,
): EventFixture {
	return {
		at: minutesAgo(minutes),
		role: "tool",
		text: `${toolName} ${toolTarget}`,
		toolName,
		toolTarget,
		toolStatus,
	};
}

function minutesAgo(minutes: number): Date {
	return new Date(+NOW - minutes * 60_000);
}

type SummaryFixture = Partial<
	Omit<typeof summaries.$inferInsert, "sessionId" | "updatedAt">
> & { updatedMinutesAgo?: number };

type EventFixture = Omit<typeof events.$inferInsert, "sessionId" | "key">;

const NOW = new Date("2026-10-23T09:00:00Z");

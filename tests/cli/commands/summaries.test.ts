import { afterEach, beforeEach, expect, test } from "bun:test";
import type { App } from "@src/app";
import { run } from "@src/cli";
import { events, sessions, summaries } from "@src/database";
import type { SessionState, ToolStatus } from "@src/harnesses";
import { createTestApp } from "@tests/utils";
import { eq } from "drizzle-orm";

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

test("the list is a table of live sessions, subagents as a tree under their parent", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "claude:helper", {
		parentId: "claude:root",
		state: "busy",
		startedMinutesAgo: 40,
	});
	addSession(app, "claude:nested", {
		parentId: "claude:helper",
		state: "busy",
		startedMinutesAgo: 35,
	});
	addSession(app, "claude:done-helper", {
		parentId: "claude:root",
		state: "ended",
		startedMinutesAgo: 45,
	});
	addSession(app, "codex:other", { state: "waiting", startedMinutesAgo: 10 });
	addSession(app, "codex:old", { state: "ended", startedMinutesAgo: 120 });
	const covered = [
		"claude:nested",
		"claude:helper",
		"claude:done-helper",
		"claude:root",
		"codex:other",
		"codex:old",
	].map((id) => {
		const newest = Math.max(...addEvents(app, id, [message(5)]));
		if (id !== "claude:root") {
			addSummary(app, id, [newest], { objective: `Objective of ${id}` });
		}
		return newest;
	});
	addSummary(app, "claude:root", covered, { objective: "Ship it" });

	const live = await runSummaries(app, ["list"]);

	expect(live.exitCode).toBe(0);
	expect(live.output).toBe(
		[
			"4 live sessions",
			"",
			"ID                 STATE    ACTIVE  WAITING  EDITS  DIR    OBJECTIVE",
			"codex:other        waiting  5m ago  none     0      /work  Objective of codex:other",
			"claude:root        busy     5m ago  none     0      /work  Ship it",
			"└ claude:helper    busy     5m ago  none     0      /work  Objective of claude:helper",
			"  └ claude:nested  busy     5m ago  none     0      /work  Objective of claude:nested",
		].join("\n"),
	);
});

test("a row shows the directory with its branch, what the session waits on, and its edits as a count", async () => {
	const app = testApp();
	addSession(app, "claude:root", {
		state: "waiting",
		cwd: "/work/status",
		branch: "stream/2e",
	});
	const ids = addEvents(app, "claude:root", [
		toolCall("Edit", "/work/status/a.ts", "ok", 4),
		toolCall("Write", "/work/status/b.ts", "ok", 3),
		toolCall("Edit", "/work/status/a.ts", "ok", 2),
	]);
	addSummary(app, "claude:root", ids, {
		objective: "Ship it\nwith  the tests",
		waitingOn: "user",
		ask: "Push the branch?",
		progress: "Wrote the command",
	});

	const result = await runSummaries(app, ["list"]);

	expect(rowsOf(result.output)).toEqual([
		[
			"claude:root",
			"waiting",
			"2m ago",
			"user",
			"2",
			"/work/status (stream/2e)",
			"Ship it with the tests",
		],
	]);
	expect(result.output).not.toContain("Push the branch?");
	expect(result.output).not.toContain("Wrote the command");
	expect(result.output).not.toContain("a.ts");
});

test("in a terminal the objective is cut to the width, and piped it's printed in full", async () => {
	const objective = `Build the parser ${"and more ".repeat(30)}end`;
	const piped = testApp();
	const terminal = testApp({ outputColumns: 80 });
	for (const app of [piped, terminal]) {
		addSession(app, "claude:root", { state: "busy" });
		addSummary(
			app,
			"claude:root",
			addEvents(app, "claude:root", [message(5)]),
			{
				objective,
			},
		);
	}

	const full = await runSummaries(piped, ["list"]);
	const cut = await runSummaries(terminal, ["list"]);

	expect(rowsOf(full.output)[0]?.at(-1)).toBe(objective);
	const row = cut.output.split("\n").at(-1) ?? "";
	expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
	expect(Bun.stringWidth(row)).toBeGreaterThan(70);
	expect(row).toEndWith("…");
	expect(row).toContain("Build the parser and more");
});

test("in a terminal the table prints the shortest unique ids and bare ages, each id resolving through `get`; piped it keeps full ids", async () => {
	const ids = [
		"claude:ac768d0a-1111",
		"claude:ac768d0a-2222",
		"claude:12345678abcdef",
		"codex:01a16b34-598b",
	];
	const piped = testApp();
	const terminal = testApp({ outputColumns: 200 });
	for (const app of [piped, terminal]) {
		for (const [index, id] of ids.entries()) {
			addSession(app, id, { state: "busy", startedMinutesAgo: 10 + index });
			addSummary(app, id, addEvents(app, id, [message(5)]));
		}
	}

	const full = await runSummaries(piped, ["list"]);
	const short = await runSummaries(terminal, ["list"]);

	expect(rowsOf(full.output).map((row) => [row[0], row[2]])).toEqual(
		ids.map((id) => [id, "5m ago"]),
	);
	const shortRows = rowsOf(short.output).map((row) => [row[0], row[2]]);
	expect(shortRows).toEqual([
		["claude:ac768d0a-1", "5m"],
		["claude:ac768d0a-2", "5m"],
		["claude:12345678", "5m"],
		["codex:01a16b34", "5m"],
	]);
	for (const [index, [shortId]] of shortRows.entries()) {
		const resolved = await runSummaries(terminal, ["get", shortId ?? ""]);
		expect(resolved.output).toStartWith(`${ids[index]}  busy`);
	}
});

test("the heading names the caller's own session, which is left out, and its subagents are marked as subagents at the top level", async () => {
	const app = testApp();
	process.env.CODEX_THREAD_ID = "thread-self";
	addSession(app, "codex:thread-self", { state: "busy" });
	addSession(app, "codex:sibling", {
		parentId: "codex:thread-self",
		state: "busy",
	});
	addSession(app, "codex:peer", { state: "idle" });
	for (const id of ["codex:thread-self", "codex:sibling", "codex:peer"]) {
		addSummary(app, id, addEvents(app, id, [message(5)]));
	}

	const result = await runSummaries(app, ["list"]);

	expect(idColumn(result.output).sort()).toEqual([
		"codex:peer",
		"↑ codex:sibling",
	]);
	expect(result.output.split("\n")[0]).toBe(
		"2 live sessions, leaving out this session: codex:thread-self",
	);
});

test("WAITING says behind when a deferred family has moved past the summary, and no summary when there is none", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "codex:new", { state: "busy", startedMinutesAgo: 20 });
	const ids = addEvents(app, "claude:root", [message(9)]);
	addSummary(app, "claude:root", ids, { updatedMinutesAgo: 5 });
	addEvents(app, "claude:root", [message(1)]);

	const result = await runSummaries(app, ["list"]);

	expect(rowsOf(result.output).map((row) => [row[0], row[3]])).toEqual([
		["codex:new", "no summary"],
		["claude:root", "behind"],
	]);
});

test("a failed refresh prints the list, then the failure, marks that summary behind and exits 1", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "idle" });
	const ids = addEvents(app, "claude:root", [message(9)]);
	addSummary(app, "claude:root", ids, { updatedMinutesAgo: 9 });
	addEvents(app, "claude:root", [message(1)]);

	const result = await runSummaries(app, ["list"]);

	expect(result.exitCode).toBe(1);
	expect(rowsOf(result.output).map((row) => row[3])).toEqual(["behind"]);
	expect(result.output).toContain(
		"\n\nfailed: summary claude:root: askClaude was called without a fake",
	);
});

test("`summaries get` carries what the list leaves out: parent, ask, progress, tried, next, blockers and the edited files", async () => {
	const app = testApp();
	addSession(app, "claude:root", { state: "idle" });
	addSession(app, "claude:child", {
		parentId: "claude:root",
		state: "waiting",
		title: "Add the summaries command",
		cwd: "/work/status",
		branch: "stream/2e",
	});
	const ids = addEvents(app, "claude:child", [
		toolCall("Edit", "/work/status/a.ts", "ok", 4),
	]);
	addSummary(app, "claude:child", ids, {
		progress: "Wrote the command\nWrote the tests",
		tried: "Bun.spawn with a PATH fake, which ran the real claude",
		next: "Open the PR",
		blockers: "",
		waitingOn: "user",
		ask: "Push the branch?\nThe tests pass.",
	});

	const result = await runSummaries(app, ["get", "claude:child"]);

	expect(result.output).toStartWith(
		[
			"claude:child  waiting  active 4m ago",
			"  title: Add the summaries command",
			"  parent: claude:root",
			"  cwd: /work/status",
			"  branch: stream/2e",
			"  objective: Ship it",
			"  outcome: in_progress, waiting on user",
			"  ask: Push the branch?",
			"    The tests pass.",
			"  progress:",
			"    - Wrote the command",
			"    - Wrote the tests",
			"  tried:",
			"    - Bun.spawn with a PATH fake, which ran the real claude",
			"  next:",
			"    - Open the PR",
			"  blockers: none",
			"  edited in the last 30m:",
			"    - /work/status/a.ts",
		].join("\n"),
	);
});

test("`summaries get` shows one session in full, with its subagents and its recent tool calls, whatever its state", async () => {
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

	const result = await runSummaries(app, ["get", "codex:root"]);
	const child = await runSummaries(app, ["get", "codex:grandchild"]);

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

test("an unknown session id fails closed after the refresh", async () => {
	const app = testApp();

	const result = await runSummaries(app, ["get", "claude:nope"]);

	expect(result.exitCode).toBe(1);
	expect(result.output).toBe('status: unknown session "claude:nope"');
});

test("`summaries get` fails closed on a prefix several sessions share, listing them", async () => {
	const app = testApp();
	addSession(app, "claude:ac768d0a-2222", { state: "ended", title: "Second" });
	addSession(app, "claude:ac768d0a-1111", { state: "ended" });
	addSession(app, "codex:01a1", { state: "ended", title: "Spike" });

	const result = await runSummaries(app, ["get", "claude:ac768d0a"]);

	expect(result.exitCode).toBe(1);
	expect(result.output).toBe(
		[
			'status: "claude:ac768d0a" matches 2 sessions; give more of the id:',
			"  claude:ac768d0a-1111  untitled",
			"  claude:ac768d0a-2222  Second",
		].join("\n"),
	);
});

function testApp(overrides: Partial<App> = {}): App {
	return createTestApp({ adapters: [], now: () => NOW, ...overrides });
}

async function runSummaries(app: App, args: string[]) {
	const result = await run(["summaries", ...args], () => app);
	return { ...result, output: Bun.stripANSI(result.output) };
}

function rowsOf(output: string): string[][] {
	const lines = output.split("\n");
	const start = lines.findIndex((line) => line.startsWith("ID  "));
	const end = lines.indexOf("", start);
	return lines
		.slice(start + 1, end === -1 ? undefined : end)
		.map((line) => line.split(/(?<=\S) {2,}/));
}

function idColumn(output: string): string[] {
	return rowsOf(output).map((row) => row[0] ?? "");
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

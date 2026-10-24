import { expect, test } from "bun:test";
import type { App } from "@src/app";
import { status } from "@src/cli/commands/status";
import { events, sessions, summaries } from "@src/database";
import type { HarnessAdapter, SessionState } from "@src/harnesses";
import type { ClaudeRequest } from "@src/utils";
import { createTestApp } from "@tests/utils";

test("sessions are grouped by goal, with buckets ordered blocked, running, finished", async () => {
	const app = createLiveApp(
		{ "claude:blocked": "waiting", "claude:running": "busy" },
		answer([
			{
				name: "Ship the parser",
				sessions: [
					{
						id: "claude:finished",
						bucket: "finished",
						line: "Merged the parser as abc1234.",
					},
					{
						id: "claude:running",
						bucket: "running",
						line: "Running the parser's tests.",
					},
				],
			},
			{
				name: "Release notes",
				sessions: [
					{ id: "claude:blocked", bucket: "blocked", line: "Draft is ready." },
				],
			},
		]),
	);
	addRoot(app, "claude:finished", { minutesAgo: 30 });
	addSummary(app, "claude:finished", { outcome: "done" });
	addRoot(app, "claude:running", { minutesAgo: 1 });
	addSummary(app, "claude:running", {});
	addRoot(app, "claude:blocked", { minutesAgo: 120, branch: "notes" });
	addSummary(app, "claude:blocked", {
		waitingOn: "user",
		ask: "Publish the draft?\nA) to the blog\nB) to the newsletter",
	});

	const result = await status([], () => app);

	expect(result.exitCode).toBe(0);
	expect(Bun.stripANSI(result.output)).toBe(
		[
			"1 blocked on you · 1 running · 1 finished  last 7 days",
			"",
			"Release notes",
			"  blocked on you",
			"    claude:blocked  waiting · /work/repo (notes) · 2h ago",
			"      Draft is ready.",
			"      ask: Publish the draft?",
			"        A) to the blog",
			"        B) to the newsletter",
			"",
			"Ship the parser",
			"  running",
			"    claude:running  busy · /work/repo · 1m ago",
			"      Running the parser's tests.",
			"  finished",
			"    claude:finished  ended · /work/repo · 30m ago",
			"      Merged the parser as abc1234.",
		].join("\n"),
	);
});

test("Opus's bucket stands, even against the live state", async () => {
	const requests: ClaudeRequest[] = [];
	const app = createLiveApp(
		{
			"claude:busy": "busy",
			"claude:parent": "idle",
			"claude:child": "waiting",
		},
		async (request) => {
			requests.push(request);
			return answer([
				{
					name: "Everything",
					sessions: [
						{ id: "claude:busy", bucket: "finished", line: "Done." },
						{ id: "claude:ended", bucket: "running", line: "CI runs." },
						{ id: "claude:parent", bucket: "blocked", line: "Approve." },
					],
				},
			])();
		},
	);
	addRoot(app, "claude:busy", { minutesAgo: 1 });
	addSummary(app, "claude:busy", {});
	addRoot(app, "claude:ended", { minutesAgo: 2 });
	addSummary(app, "claude:ended", { outcome: "done" });
	addRoot(app, "claude:parent", { minutesAgo: 3 });
	addSummary(app, "claude:parent", { outcome: "done" });
	addRoot(app, "claude:child", { parentId: "claude:parent", minutesAgo: 3 });
	addSummary(app, "claude:child", { objective: "Run the migration" });

	const result = await status([], () => app);

	expect(result.exitCode).toBe(0);
	expect(Bun.stripANSI(result.output).split("\n")[0]).toBe(
		"1 blocked on you · 1 running · 1 finished  last 7 days",
	);
	expect(bucketsIn(result.output)).toEqual({
		"blocked on you": ["claude:parent"],
		running: ["claude:ended"],
		finished: ["claude:busy"],
	});
	const input = (requests[0] as ClaudeRequest).input;
	expect(input).not.toContain("## claude:child");
	expect(input).toContain("- waiting subagent: Run the migration");
});

test("a bucket that isn't one of the three fails the run", async () => {
	const app = createLiveApp(
		{},
		answer([
			{
				name: "Work",
				sessions: [{ id: "claude:one", bucket: "paused", line: "Paused." }],
			},
		]),
	);
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", {});

	const result = await status([], () => app);

	expect(result.exitCode).toBe(1);
	expect(Bun.stripANSI(result.output)).toEndWith(
		'failed: grouping by goal: the answer gives a bucket that isn\'t one of blocked, running, finished: "paused"',
	);
});

test("a waiting session with no ask still says a prompt is open", async () => {
	const app = createLiveApp(
		{ "claude:prompted": "waiting" },
		answer([
			{
				name: "Deploy",
				sessions: [
					{
						id: "claude:prompted",
						bucket: "blocked",
						line: "About to deploy.",
					},
				],
			},
		]),
	);
	addRoot(app, "claude:prompted", {});
	addSummary(app, "claude:prompted", {});

	const result = await status([], () => app);

	expect(Bun.stripANSI(result.output)).toContain(
		"ask: a permission prompt or question is open in the session",
	);
});

test("a blocked session whose subagent holds a prompt says so", async () => {
	const app = createLiveApp(
		{ "claude:parent": "busy", "claude:child": "waiting" },
		answer([
			{
				name: "Migrate",
				sessions: [
					{
						id: "claude:parent",
						bucket: "blocked",
						line: "Running the migration.",
					},
				],
			},
		]),
	);
	addRoot(app, "claude:parent", {});
	addSummary(app, "claude:parent", {});
	addRoot(app, "claude:child", { parentId: "claude:parent" });

	const result = await status([], () => app);

	expect(bucketsIn(result.output)).toEqual({
		"blocked on you": ["claude:parent"],
	});
	expect(Bun.stripANSI(result.output)).toContain(
		"ask: a permission prompt or question is open in a subagent",
	);
});

test("an id the grouping made up fails the run and still lists every session", async () => {
	const app = createLiveApp(
		{},
		answer([
			{
				name: "Work",
				sessions: [
					{ id: "claude:one", bucket: "finished", line: "Did one." },
					{ id: "claude:invented", bucket: "finished", line: "Did nothing." },
				],
			},
		]),
	);
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done", objective: "Do one" });

	const result = await status([], () => app);

	expect(result.exitCode).toBe(1);
	const output = Bun.stripANSI(result.output);
	expect(output).toStartWith(
		"1 not grouped  last 7 days\n\nNot grouped\n    claude:one",
	);
	expect(output).toContain("      Do one");
	expect(output).toEndWith(
		"failed: grouping by goal: the answer names a session that wasn't asked about: claude:invented",
	);
});

test("a failed grouping still prints each session's open question", async () => {
	const app = createLiveApp({ "claude:asking": "waiting" }, rejectCall);
	addRoot(app, "claude:asking", {});
	addSummary(app, "claude:asking", {
		waitingOn: "user",
		ask: "Publish the draft?",
	});

	const result = await status([], () => app);

	expect(result.exitCode).toBe(1);
	expect(Bun.stripANSI(result.output)).toContain(
		"Not grouped\n    claude:asking  waiting · /work/repo · 5m ago\n      Objective of claude:asking\n      ask: Publish the draft?",
	);
});

test("a session listed twice fails the run", async () => {
	const app = createLiveApp(
		{},
		answer([
			{
				name: "One",
				sessions: [{ id: "claude:one", bucket: "finished", line: "First." }],
			},
			{
				name: "Two",
				sessions: [{ id: "claude:one", bucket: "finished", line: "Again." }],
			},
		]),
	);
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done" });

	const result = await status([], () => app);

	expect(result.exitCode).toBe(1);
	expect(Bun.stripANSI(result.output)).toEndWith(
		"failed: grouping by goal: the answer lists claude:one more than once",
	);
});

test("a session the grouping left out is shown ungrouped, with a warning", async () => {
	const app = createLiveApp(
		{},
		answer([
			{
				name: "Kept",
				sessions: [{ id: "claude:kept", bucket: "finished", line: "Kept it." }],
			},
		]),
	);
	addRoot(app, "claude:kept", {});
	addSummary(app, "claude:kept", { outcome: "done" });
	addRoot(app, "claude:left", {});
	addSummary(app, "claude:left", { outcome: "done", objective: "Left out" });

	const result = await status([], () => app);

	expect(result.exitCode).toBe(0);
	const output = Bun.stripANSI(result.output);
	expect(output).toContain("Not grouped\n    claude:left");
	expect(output).toStartWith(
		"0 blocked on you · 0 running · 1 finished · 1 not grouped",
	);
	expect(output).toContain("      Left out");
	expect(output).toEndWith(
		'warning: the grouping left out claude:left, shown under "Not grouped"',
	);
});

test("a summary that hasn't caught up with its session is marked behind", async () => {
	const app = createLiveApp(
		{ "claude:busy": "busy" },
		answer([
			{
				name: "Work",
				sessions: [{ id: "claude:busy", bucket: "running", line: "Working." }],
			},
		]),
	);
	addRoot(app, "claude:busy", {});
	addSummary(app, "claude:busy", { updatedAt: app.now() });
	app.database
		.insert(events)
		.values({
			sessionId: "claude:busy",
			key: "claude:busy:1",
			at: app.now(),
			role: "user",
			text: "keep going",
		})
		.run();

	const result = await status([], () => app);

	expect(Bun.stripANSI(result.output)).toContain(
		"claude:busy  busy · /work/repo · 5m ago · summary behind",
	);
});

test("an empty window prints a short line and asks no one", async () => {
	const app = createTestApp();

	const result = await status(["--days", "3"], () => app);

	expect(result).toEqual({
		output: "No sessions in the last 3 days.",
		exitCode: 0,
	});
});

test("sessions older than the window are left out", async () => {
	const app = createLiveApp({});
	addRoot(app, "claude:old", { minutesAgo: 8 * 24 * 60 });
	addSummary(app, "claude:old", { outcome: "done" });

	const result = await status([], () => app);

	expect(result.output).toBe("No sessions in the last 7 days.");
});

test("a failed refresh prints what it has, then the failure, and exits 1", async () => {
	const app = createTestApp({
		adapters: [
			{
				...liveAdapter({}),
				listSources: async () => {
					throw new Error("the sessions directory is unreadable");
				},
			},
		],
		askClaude: answer([
			{
				name: "Work",
				sessions: [{ id: "claude:one", bucket: "finished", line: "Did one." }],
			},
		]),
		now: () => NOW,
	});
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done" });

	const result = await status([], () => app);

	expect(result.exitCode).toBe(1);
	const output = Bun.stripANSI(result.output);
	expect(output).toContain("Work\n  finished\n    claude:one");
	expect(output).toEndWith(
		"failed: claude list: the sessions directory is unreadable",
	);
});

function createLiveApp(
	live: Record<string, Exclude<SessionState, "ended">>,
	askClaude: App["askClaude"] = rejectCall,
): App {
	return createTestApp({
		adapters: [liveAdapter(live)],
		askClaude,
		now: () => NOW,
	});
}

function liveAdapter(
	live: Record<string, Exclude<SessionState, "ended">>,
): HarnessAdapter {
	return {
		harness: "claude",
		listSources: async () => [],
		readSource: async () => null,
		snapshot: async (records) => ({
			snapshots: records.flatMap((record) => {
				const state = live[record.id];
				return state
					? [
							{
								sessionId: record.id,
								state,
								cwd: record.cwd,
								branch: record.branch,
							},
						]
					: [];
			}),
			warnings: [],
		}),
	};
}

function addRoot(
	app: App,
	id: string,
	options: { minutesAgo?: number; branch?: string; parentId?: string },
) {
	const lastEventAt = new Date(+NOW - (options.minutesAgo ?? 5) * 60_000);
	app.database
		.insert(sessions)
		.values({
			id,
			harness: "claude",
			surface: "unknown",
			parentId: options.parentId ?? null,
			title: null,
			cwd: "/work/repo",
			branch: options.branch ?? null,
			state: "ended",
			observedAt: lastEventAt,
			startedAt: lastEventAt,
			lastEventAt,
			sourcePath: `/transcripts/${id}.jsonl`,
			readOffset: 0,
		})
		.run();
}

function addSummary(
	app: App,
	sessionId: string,
	fields: Partial<typeof summaries.$inferInsert>,
) {
	app.database
		.insert(summaries)
		.values({
			sessionId,
			throughEventId: 0,
			objective: `Objective of ${sessionId}`,
			progress: "",
			tried: "",
			next: "",
			blockers: "",
			waitingOn: "none",
			ask: null,
			outcome: "in_progress",
			updatedAt: NOW,
			...fields,
		})
		.run();
}

function answer(goals: { name: string; sessions: SessionLine[] }[]) {
	return async () => ({
		output: { goals },
		inputTokens: 0,
		largestPromptTokens: 0,
	});
}

function bucketsIn(output: string): Record<string, string[]> {
	const buckets: Record<string, string[]> = {};
	let current = "";
	for (const line of Bun.stripANSI(output).split("\n")) {
		const bucket = line.match(/^ {2}(\S.*)$/)?.[1];
		const session = line.match(/^ {4}(\S+) {2}/)?.[1];
		if (/^\S/.test(line)) {
			current = "";
		} else if (bucket) {
			current = bucket;
			buckets[current] = [];
		} else if (session) {
			buckets[current]?.push(session);
		}
	}
	return buckets;
}

async function rejectCall(): Promise<never> {
	throw new Error("no call expected");
}

type SessionLine = { id: string; bucket: string; line: string };

const NOW = new Date("2026-10-23T12:00:00Z");

import { expect, test } from "bun:test";
import type { App } from "@src/app";
import { statusGet, statusList } from "@src/cli/commands/status";
import { events, sessions, summaries } from "@src/database";
import type { HarnessAdapter, SessionState } from "@src/harnesses";
import type { ClaudeRequest } from "@src/utils";
import { createTestApp } from "@tests/utils";

test("the brief lists goals that need you in Opus's order, then running, then finished on one line", async () => {
	const app = createLiveApp(
		{ "claude:running-1111": "busy" },
		briefOf([
			{
				name: "Spikes",
				status: "finished",
				done: ["Env vars confirmed, rejection test passed."],
				sessions: ["codex:spike-aaaa1", "codex:spike-aaaa2"],
			},
			{
				name: "Release notes",
				status: "needs_you",
				goal: "Publish the release notes for 2.0.",
				next: [
					"Choose where to publish the draft; the session recommends the blog.",
				],
				sessions: ["claude:notes-2222"],
			},
			{
				name: "Parser",
				status: "running",
				goal: "Ship the new parser.",
				done: ["Parser merged as abc1234; 40 tests pass."],
				next: ["Running the full test suite."],
				sessions: ["claude:running-1111"],
			},
			{
				name: "Login fix",
				status: "needs_you",
				goal: "Fix the flaky login test.",
				blockers: [
					"The test database isn't running, so the fix can't be verified.",
				],
				next: [
					"Start the test database.",
					"Resume the session to rerun the test.",
				],
				sessions: ["claude:login-3333"],
			},
		]),
	);
	addRoot(app, "claude:running-1111", { minutesAgo: 1 });
	addSummary(app, "claude:running-1111", {});
	addRoot(app, "claude:notes-2222", { minutesAgo: 120 });
	addSummary(app, "claude:notes-2222", { waitingOn: "user", ask: "Blog?" });
	addRoot(app, "claude:login-3333", { minutesAgo: 30 });
	addSummary(app, "claude:login-3333", {});
	addRoot(app, "codex:spike-aaaa1", { minutesAgo: 300 });
	addSummary(app, "codex:spike-aaaa1", { outcome: "done" });
	addRoot(app, "codex:spike-aaaa2", { minutesAgo: 300 });
	addSummary(app, "codex:spike-aaaa2", { outcome: "done" });

	const result = await statusList([], () => app);

	expect(result.exitCode).toBe(0);
	expect(Bun.stripANSI(result.output)).toBe(
		[
			"Last 7 days · 2 goals need you · 1 running · 1 finished",
			"",
			"NEEDS YOU",
			"1. Release notes",
			"   Goal:     Publish the release notes for 2.0.",
			"   Next:     1. Choose where to publish the draft; the session recommends the blog.",
			"   ↳ claude:notes-22 · ended 2h ago",
			"",
			"2. Login fix",
			"   Goal:     Fix the flaky login test.",
			"   Blockers: - The test database isn't running, so the fix can't be verified.",
			"   Next:     1. Start the test database.",
			"             2. Resume the session to rerun the test.",
			"   ↳ claude:login-33 · ended 30m ago",
			"",
			"RUNNING",
			"1. Parser",
			"   Goal:     Ship the new parser.",
			"   Done:     - Parser merged as abc1234; 40 tests pass.",
			"   Now:      1. Running the full test suite.",
			"   ↳ claude:running- · busy 1m ago",
			"",
			"FINISHED",
			"- Spikes: Env vars confirmed, rejection test passed.",
			"  ↳ codex:spike-aaaa1, codex:spike-aaaa2",
		].join("\n"),
	);
});

test("the brief wraps to the terminal's width, aligned under each field", async () => {
	const app = createTestApp({
		adapters: [liveAdapter({})],
		now: () => NOW,
		outputColumns: 50,
		askClaude: briefOf([
			{
				name: "Work",
				status: "needs_you",
				goal: "A goal long enough that it has to wrap onto a second line.",
				next: ["Decide which of the two options to take today."],
				sessions: ["claude:one"],
			},
		]),
	});
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", {});

	const result = await statusList([], () => app);

	expect(Bun.stripANSI(result.output)).toContain(
		[
			"   Goal:     A goal long enough that it has to",
			"             wrap onto a second line.",
			"   Next:     1. Decide which of the two options to",
			"                take today.",
		].join("\n"),
	);
});

test("a short id stays unique among stored sessions the brief doesn't show", async () => {
	const app = createLiveApp(
		{ "claude:abcdefgh-new": "busy" },
		briefOf([{ status: "running", sessions: ["claude:abcdefgh-new"] }]),
	);
	addRoot(app, "claude:abcdefgh-new", {});
	addSummary(app, "claude:abcdefgh-new", {});
	addRoot(app, "claude:abcdefgh-old", { minutesAgo: 8 * 24 * 60 });

	const result = await statusList([], () => app);

	expect(result.exitCode).toBe(0);
	expect(Bun.stripANSI(result.output)).toContain(
		"↳ claude:abcdefgh-n · busy 5m ago",
	);
});

test("a root's footnote counts its live subagents", async () => {
	const app = createLiveApp(
		{ "claude:parent": "idle", "claude:child": "waiting" },
		briefOf([{ status: "needs_you", sessions: ["claude:parent"] }]),
	);
	addRoot(app, "claude:parent", {});
	addSummary(app, "claude:parent", {});
	addRoot(app, "claude:child", { parentId: "claude:parent" });

	const result = await statusList([], () => app);

	expect(Bun.stripANSI(result.output)).toContain(
		"↳ claude:parent · idle 5m ago · + 1 agent",
	);
});

test("a brief that failed lists every session under NOT GROUPED with its open question, and exits 1", async () => {
	const app = createLiveApp(
		{ "claude:prompted": "waiting" },
		briefOf([{ sessions: ["claude:asking", "claude:invented"] }]),
	);
	addRoot(app, "claude:asking", {});
	addSummary(app, "claude:asking", {
		waitingOn: "user",
		ask: "Publish the draft?\nA) to the blog",
	});
	addRoot(app, "claude:prompted", { minutesAgo: 10 });
	addSummary(app, "claude:prompted", {});

	const result = await statusList([], () => app);

	expect(result.exitCode).toBe(1);
	expect(Bun.stripANSI(result.output)).toBe(
		[
			"Last 7 days · 2 sessions not grouped",
			"",
			"NOT GROUPED",
			"- claude:asking  ended · /work/repo · 5m ago",
			"  Objective of claude:asking",
			"  ask: Publish the draft?",
			"  A) to the blog",
			"",
			"- claude:prompted  waiting · /work/repo · 10m ago",
			"  Objective of claude:prompted",
			"  ask: a permission prompt or question is open in the session",
			"",
			"failed: writing the brief: the answer names a session that wasn't asked about: claude:invented",
		].join("\n"),
	);
});

test("a session the brief left out is shown ungrouped, with a warning", async () => {
	const app = createLiveApp(
		{},
		briefOf([{ done: ["Kept it."], sessions: ["claude:kept"] }]),
	);
	addRoot(app, "claude:kept", {});
	addSummary(app, "claude:kept", { outcome: "done" });
	addRoot(app, "claude:left", {});
	addSummary(app, "claude:left", { outcome: "done", objective: "Left out" });

	const result = await statusList([], () => app);

	expect(result.exitCode).toBe(0);
	const output = Bun.stripANSI(result.output);
	expect(output).toStartWith(
		"Last 7 days · 0 goals need you · 0 running · 1 finished · 1 session not grouped",
	);
	expect(output).toContain(
		"NOT GROUPED\n- claude:left  ended · /work/repo · 5m ago\n  Left out",
	);
	expect(output).toEndWith(
		"warning: the brief left out claude:left, shown under NOT GROUPED",
	);
});

test("a summary that hasn't caught up with its session is marked behind", async () => {
	const app = createLiveApp(
		{ "claude:busy": "busy" },
		briefOf([{ status: "running", sessions: ["claude:busy"] }]),
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

	const result = await statusList([], () => app);

	expect(Bun.stripANSI(result.output)).toContain(
		"↳ claude:busy · busy 5m ago · summary behind",
	);
});

test("an empty window prints a short line and asks no one", async () => {
	const app = createTestApp();

	const result = await statusList(["--days", "3"], () => app);

	expect(result).toEqual({
		output: "No sessions in the last 3 days.",
		exitCode: 0,
	});
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
		askClaude: briefOf([{ done: ["Did one."], sessions: ["claude:one"] }]),
		now: () => NOW,
	});
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done" });

	const result = await statusList([], () => app);

	expect(result.exitCode).toBe(1);
	const output = Bun.stripANSI(result.output);
	expect(output).toContain("FINISHED\n- Work: Did one.");
	expect(output).toEndWith(
		"failed: claude list: the sessions directory is unreadable",
	);
});

test("`get` answers one question with the sessions it relied on, from the same input as `list`", async () => {
	const requests: ClaudeRequest[] = [];
	const app = createLiveApp({ "claude:asking": "waiting" }, async (request) => {
		requests.push(request);
		return {
			output: {
				answer:
					"One thing: claude:asking wants you to pick a blog or the newsletter.",
				sessions: ["claude:asking", "claude:asking"],
			},
			inputTokens: 0,
			largestPromptTokens: 0,
		};
	});
	addRoot(app, "claude:asking", { minutesAgo: 120, branch: "notes" });
	addSummary(app, "claude:asking", { waitingOn: "user", ask: "Publish?" });
	addRoot(app, "claude:other", {});
	addSummary(app, "claude:other", {});

	const result = await statusGet(["what's blocked on me?"], () => app);

	expect(result.exitCode).toBe(0);
	expect(Bun.stripANSI(result.output)).toBe(
		[
			"One thing: claude:asking wants you to pick a blog or the newsletter.",
			"",
			"sessions:",
			"  claude:asking  waiting · /work/repo (notes) · 2h ago",
		].join("\n"),
	);
	const request = requests[0] as ClaudeRequest;
	expect(requests).toHaveLength(1);
	expect(request.model).toBe("claude-opus-5-5");
	expect(request.effort).toBe("medium");
	expect(request.input).toContain("## claude:other\nlive state: ended");
	expect(request.input).toContain("ask: Publish?");
	expect(request.input).toEndWith("\n\nQuestion: what's blocked on me?");
});

test("`get` prints only the answer when no session bears on it", async () => {
	const app = createLiveApp({}, async () => ({
		output: { answer: "Nothing is blocked on you.", sessions: [] },
		inputTokens: 0,
		largestPromptTokens: 0,
	}));
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done" });

	const result = await statusGet(["what's blocked on me?"], () => app);

	expect(result).toEqual({ output: "Nothing is blocked on you.", exitCode: 0 });
});

test("`get` over an empty window prints a short line and asks no one", async () => {
	const app = createTestApp();

	const result = await statusGet(["what's running?", "--days", "2"], () => app);

	expect(result).toEqual({
		output: "No sessions in the last 2 days.",
		exitCode: 0,
	});
});

test("the Opus call is logged as it starts and when it answers, then the run's totals", async () => {
	const lines: string[] = [];
	let now = NOW;
	const fake = briefOf([{ sessions: ["claude:one"] }]);
	const app = createTestApp({
		adapters: [liveAdapter({})],
		now: () => now,
		progress: (tag, message) =>
			lines.push(`[${tag}] ${Bun.stripANSI(message)}`),
		askClaude: async (request) => {
			now = new Date(+now + 2_500);
			return { ...(await fake(request)), inputTokens: 12_345 };
		},
	});
	addRoot(app, "claude:one", {});
	addSummary(app, "claude:one", { outcome: "done" });

	await statusList([], () => app);

	expect(lines.filter((line) => !line.startsWith("[sync]"))).toEqual([
		"[summaries] every summary is current",
		"[judge] asking Opus to brief 1 session by goal",
		"[judge] answered in 2.5s, 12,345 input tokens",
		"[total] done in 2.5s · Haiku 0 calls, 0 input tokens · Opus 1 call, 12,345 input tokens",
	]);
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

function briefOf(goals: Partial<BriefGoal>[]): App["askClaude"] {
	return async () => ({
		output: {
			goals: goals.map((goal) => ({
				name: "Work",
				status: "finished",
				goal: "What the work is.",
				done: [],
				blockers: [],
				next: [],
				sessions: [],
				...goal,
			})),
		},
		inputTokens: 0,
		largestPromptTokens: 0,
	});
}

async function rejectCall(): Promise<never> {
	throw new Error("no call expected");
}

type BriefGoal = {
	name: string;
	status: string;
	goal: string;
	done: string[];
	blockers: string[];
	next: string[];
	sessions: string[];
};

const NOW = new Date("2026-10-23T12:00:00Z");

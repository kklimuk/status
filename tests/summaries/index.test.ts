import { expect, test } from "bun:test";
import type { App } from "@src/app";
import { events, sessions, summaries } from "@src/database";
import type { ToolStatus } from "@src/harnesses";
import { refreshSummaries } from "@src/summaries";
import type { ClaudeRequest, ClaudeResponse } from "@src/utils";
import { createTestApp } from "@tests/utils";
import { eq } from "drizzle-orm";

test("a session without a summary is summarized from all its events, through its newest event", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root", { title: "Summaries", cwd: "/work/status" });
	const ids = addEvents(app, "claude:root", [
		message("user", "Add rolling summaries to status", 0),
		toolCall("Edit src/summaries/index.ts", "src/summaries/index.ts", "ok", 1),
		toolCall("Bash bun test", "bun test", "error", 2),
		message("assistant", "Two tests fail on the chunk boundary.", 3),
	]);

	const report = await refreshSummaries(app);

	expect(claude.requests).toHaveLength(1);
	expect(claude.requests[0]?.model).toBe("claude-haiku-5-5");
	expect(claude.requests[0]?.input).toContain(
		"Working directory: /work/status",
	);
	expect(claude.requests[0]?.input).toContain(
		"[2026-10-23 09:01 tool, ok] Edit src/summaries/index.ts",
	);
	expect(claude.requests[0]?.input).toContain(
		"[2026-10-23 09:02 tool, error] Bash bun test",
	);
	expect(claude.requests[0]?.input).not.toContain("Summary so far");
	expect(report).toEqual({
		roots: { refreshed: 1, calls: 1, inputTokens: 1_500 },
		subagents: { refreshed: 0, calls: 0, inputTokens: 0 },
		deferred: [],
		warnings: [],
		failures: [],
	});
	expect(storedSummary(app, "claude:root")).toEqual({
		sessionId: "claude:root",
		throughEventId: Math.max(...ids),
		objective: "Add rolling summaries",
		progress: "Wrote src/summaries/index.ts\nbun test runs",
		tried: "",
		next: "Fix the chunk boundary",
		blockers: "",
		waitingOn: "none",
		ask: null,
		outcome: "in_progress",
		updatedAt: NOW,
	});
});

test("a summary is refreshed only after new events, from the previous summary, the first user message and those events", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [
		message("user", "Add rolling summaries to status", 0),
		message("assistant", "Starting with the schema.", 1),
	]);
	await refreshSummaries(app);

	const unchanged = await refreshSummaries(app);
	addEvents(app, "claude:root", [
		message("assistant", "The schema needs no change.", 5),
	]);
	await refreshSummaries(app);

	expect(unchanged.roots.refreshed).toBe(0);
	expect(claude.requests).toHaveLength(2);
	const input = claude.requests[1]?.input ?? "";
	expect(input).toContain("## Summary so far");
	expect(input).toContain("objective: Add rolling summaries");
	expect(input).toContain(
		"## First user message\n\nAdd rolling summaries to status",
	);
	expect(input).toContain("The schema needs no change.");
	expect(input).not.toContain("Starting with the schema.");
});

test("a subagent is summarized before its parent, and its summary feeds the parent's input where it was last active", async () => {
	const claude = fakeClaude((request) =>
		request.input.includes("Subagent of: claude:root")
			? { ...SUMMARY, objective: "Look for dropped events in src/sync" }
			: SUMMARY,
	);
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addSession(app, "claude:agent", {
		parentId: "claude:root",
		lastEventAt: minutesAfterStart(8),
	});
	addEvents(app, "claude:root", [
		message("user", "Find why sync drops events", 0),
		toolCall("Task Explore sync", null, "ok", 1),
		message("assistant", "The explorer found nothing in sync.", 9),
	]);
	addEvents(app, "claude:agent", [
		message("user", "Look for dropped events in src/sync", 2),
		toolCall("Grep onConflictDoUpdate", "onConflictDoUpdate", "ok", 4),
		message("assistant", "No dropped events: every upsert keeps its id.", 8),
	]);

	const report = await refreshSummaries(app);

	const [agent = "", root = ""] = claude.requests.map(
		(request) => request.input,
	);
	expect(agent).toContain("Subagent of: claude:root");
	expect(agent).toContain(
		"[2026-10-23 09:04 tool, ok] Grep onConflictDoUpdate",
	);
	expect(
		order(root, [
			"Task Explore sync",
			"[2026-10-23 09:08 subagent claude:agent's summary]\nobjective: Look for dropped events in src/sync",
			"The explorer found nothing",
		]),
	).toBe(true);
	expect(root).not.toContain("Grep onConflictDoUpdate");
	expect(root).not.toContain("Subagent of");
	expect(report).toMatchObject({
		roots: { refreshed: 1, calls: 1 },
		subagents: { refreshed: 1, calls: 1 },
	});
	expect(storedSummary(app, "claude:agent")?.objective).toBe(
		"Look for dropped events in src/sync",
	);
});

test("a subagent's new events refresh it and then its parent, whose update carries only that subagent's new summary", async () => {
	const claude = fakeClaude((request, index) =>
		request.input.includes("Subagent of")
			? { ...SUMMARY, objective: `subagent summary ${index}` }
			: SUMMARY,
	);
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addSession(app, "claude:agent", { parentId: "claude:root" });
	addSession(app, "claude:other", { parentId: "claude:root" });
	addEvents(app, "claude:root", [
		message("user", "Find why sync drops events", 0),
		message("assistant", "Launching two explorers.", 1),
	]);
	addEvents(app, "claude:agent", [message("user", "Read src/sync", 2)]);
	addEvents(app, "claude:other", [message("user", "Read src/app.ts", 2)]);
	await refreshSummaries(app);
	addEvents(app, "claude:agent", [
		message("assistant", "Correction: the offset skips a line.", 10),
	]);

	const report = await refreshSummaries(app);

	expect(claude.requests).toHaveLength(5);
	const [agent = "", root = ""] = claude.requests
		.slice(3)
		.map((request) => request.input);
	expect(agent).toContain("Correction: the offset skips a line.");
	expect(root).toContain("## Summary so far");
	expect(root).toContain(
		"subagent claude:agent's summary]\nobjective: subagent summary 3",
	);
	expect(root).not.toContain("claude:other");
	expect(root).not.toContain("Launching two explorers.");
	expect(report).toMatchObject({
		roots: { refreshed: 1 },
		subagents: { refreshed: 1 },
	});
});

test("nested subagents are summarized deepest first, each feeding its own parent", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "codex:root", { harness: "codex" });
	addSession(app, "codex:agent", { harness: "codex", parentId: "codex:root" });
	addSession(app, "codex:nested", {
		harness: "codex",
		parentId: "codex:agent",
		lastEventAt: minutesAfterStart(2),
	});
	addEvents(app, "codex:root", [message("user", "Audit the schema", 0)]);
	addEvents(app, "codex:nested", [
		message("user", "Check the events table", 1),
		message("assistant", "The events table has no index on at.", 2),
	]);

	const report = await refreshSummaries(app);

	const [nested = "", agent = "", root = ""] = claude.requests.map(
		(request) => request.input,
	);
	expect(nested).toContain("Subagent of: codex:agent");
	expect(agent).toContain("Subagent of: codex:root");
	expect(agent).toContain("subagent codex:nested's summary]");
	expect(root).toContain("[2026-10-23 09:02 subagent codex:agent's summary]");
	expect(root).not.toContain("codex:nested");
	expect(report.subagents.refreshed).toBe(2);
});

test("a parent whose subagent's summary failed keeps its old summary and names the subagent it waits for", async () => {
	const claude = fakeClaude((request) => {
		if (request.input.includes("Subagent of")) {
			throw new Error("claude -p exited with code 1: Overloaded");
		}
		return SUMMARY;
	});
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [message("user", "Audit the schema", 0)]);
	await refreshSummaries(app);
	const before = storedSummary(app, "claude:root");
	addSession(app, "claude:agent", { parentId: "claude:root" });
	addEvents(app, "claude:agent", [message("user", "Read src/database.ts", 1)]);

	const report = await refreshSummaries(app);

	expect(claude.requests).toHaveLength(2);
	expect(report.failures).toEqual([
		{
			sessionId: "claude:agent",
			message: "claude -p exited with code 1: Overloaded",
		},
		{
			sessionId: "claude:root",
			message: "waits for subagent claude:agent, whose summary is behind",
		},
	]);
	expect(storedSummary(app, "claude:root")).toEqual(before);
});

test("a busy root keeps its own and its subagents' summaries while its summary is younger than 15 minutes, and refreshes them all once it is older", async () => {
	const claude = fakeClaude();
	let now = NOW;
	const app = createTestApp({ askClaude: claude.askClaude, now: () => now });
	addSession(app, "claude:root", { state: "busy" });
	addSession(app, "claude:agent", { parentId: "claude:root", state: "busy" });
	addEvents(app, "claude:root", [message("user", "Add rolling summaries", 0)]);
	addEvents(app, "claude:agent", [message("user", "Read src/database.ts", 1)]);
	await refreshSummaries(app);
	addEvents(app, "claude:agent", [message("assistant", "Still reading.", 2)]);

	now = new Date(+NOW + 14 * 60_000);
	const early = await refreshSummaries(app);
	now = new Date(+NOW + 15 * 60_000);
	const late = await refreshSummaries(app);

	expect(early).toMatchObject({
		roots: { refreshed: 0 },
		subagents: { refreshed: 0 },
		deferred: ["claude:root"],
	});
	expect(late).toMatchObject({
		roots: { refreshed: 1 },
		subagents: { refreshed: 1 },
		deferred: [],
	});
	expect(claude.requests).toHaveLength(4);
});

test("a busy session keeps a summary younger than 15 minutes, and is refreshed once it is older", async () => {
	const claude = fakeClaude();
	let now = NOW;
	const app = createTestApp({ askClaude: claude.askClaude, now: () => now });
	addSession(app, "claude:root", { state: "busy" });
	addEvents(app, "claude:root", [message("user", "Add rolling summaries", 0)]);
	await refreshSummaries(app);
	addEvents(app, "claude:root", [message("assistant", "Still working.", 1)]);

	now = new Date(+NOW + 14 * 60_000);
	const early = await refreshSummaries(app);
	now = new Date(+NOW + 15 * 60_000);
	const late = await refreshSummaries(app);

	expect(early).toMatchObject({
		roots: { refreshed: 0 },
		deferred: ["claude:root"],
	});
	expect(late).toMatchObject({ roots: { refreshed: 1 }, deferred: [] });
	expect(claude.requests).toHaveLength(2);
});

test("a busy session without a summary is summarized right away", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root", { state: "busy" });
	addEvents(app, "claude:root", [message("user", "Add rolling summaries", 0)]);

	const report = await refreshSummaries(app);

	expect(report).toMatchObject({
		roots: { refreshed: 1, calls: 1 },
		deferred: [],
	});
});

test("a session too long for one prompt is summarized in chunks, each after the first carrying the summary so far and the first user message", async () => {
	const claude = fakeClaude((_request, index) => ({
		...SUMMARY,
		objective: `objective from chunk ${index + 1}`,
	}));
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [
		message("user", "Summarize the release notes", 0),
		...Array.from({ length: 20 }, (_, index) =>
			message("assistant", `note ${index} ${"x".repeat(12_000)}`, index + 1),
		),
	]);

	const report = await refreshSummaries(app);

	expect(report.roots.calls).toBe(2);
	for (const request of claude.requests) {
		expect(Buffer.byteLength(request.input)).toBeLessThan(CHUNK_BYTES);
	}
	const second = claude.requests[1]?.input ?? "";
	expect(second).toContain("objective: objective from chunk 1");
	expect(second).toContain(
		"## First user message\n\nSummarize the release notes",
	);
	expect(second).toContain("note 19");
	expect(second).not.toContain("note 0 ");
	expect(storedSummary(app, "claude:root")?.objective).toBe(
		"objective from chunk 2",
	);
});

test("text outside ASCII is chunked by its bytes, so a CJK session stays under the price threshold", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(
		app,
		"claude:root",
		Array.from({ length: 20 }, (_, index) =>
			message("assistant", "漢".repeat(12_000), index),
		),
	);

	const report = await refreshSummaries(app);

	expect(report.roots.calls).toBeGreaterThan(2);
	for (const request of claude.requests) {
		expect(Buffer.byteLength(request.input)).toBeLessThan(CHUNK_BYTES);
	}
});

test("a message too long for a chunk is cut in the middle, keeping its start and end", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [
		message("user", `START ${"x".repeat(500_000)} END`, 0),
	]);

	await refreshSummaries(app);

	const input = claude.requests[0]?.input ?? "";
	expect(input).toContain("START");
	expect(input).toContain("END");
	expect(input).toContain("characters cut");
	expect(input.length).toBeLessThan(20_000);
});

test("a failed call keeps the old summary, and the others still refresh", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	for (const id of ["claude:one", "claude:two"]) {
		addSession(app, id);
		addEvents(app, id, [message("user", `Work on ${id}`, 0)]);
	}
	await refreshSummaries(app);
	const before = storedSummary(app, "claude:one");
	for (const id of ["claude:one", "claude:two"]) {
		addEvents(app, id, [message("assistant", `More on ${id}`, 1)]);
	}
	claude.respond = (request) => {
		if (request.input.includes("More on claude:one")) {
			throw new Error("claude -p exited with code 1: Overloaded");
		}
		return SUMMARY;
	};

	const report = await refreshSummaries(app);

	expect(report.failures).toEqual([
		{
			sessionId: "claude:one",
			message: "claude -p exited with code 1: Overloaded",
		},
	]);
	expect(report.roots.refreshed).toBe(1);
	expect(storedSummary(app, "claude:one")).toEqual(before);
});

test("a failure in a later chunk stores nothing", async () => {
	const claude = fakeClaude((_request, index) => {
		if (index === 1) {
			throw new Error("claude -p was killed by SIGTERM");
		}
		return SUMMARY;
	});
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(
		app,
		"claude:root",
		Array.from({ length: 30 }, (_, index) =>
			message("assistant", "x".repeat(12_000), index),
		),
	);

	const report = await refreshSummaries(app);

	expect(report).toMatchObject({ roots: { refreshed: 0, calls: 1 } });
	expect(report.failures).toHaveLength(1);
	expect(storedSummary(app, "claude:root")).toBeUndefined();
});

test("an answer that doesn't match the summary schema fails closed", async () => {
	const claude = fakeClaude(() => ({ ...SUMMARY, outcome: "finished" }));
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [message("user", "Add summaries", 0)]);

	const report = await refreshSummaries(app);

	expect(report.failures).toEqual([
		{
			sessionId: "claude:root",
			message: expect.stringContaining('"finished" for outcome'),
		},
	]);
	expect(storedSummary(app, "claude:root")).toBeUndefined();
});

test("an ask comes exactly with waiting on the user, and a done session waits on no one, or the summary fails closed", async () => {
	const answers: Record<string, Record<string, unknown>> = {
		"claude:offered": { waiting_on: "user", ask: "Push and open a PR?" },
		"claude:unlabeled": { waiting_on: "none", ask: "Push and open a PR?" },
		"claude:unasked": { waiting_on: "user", ask: null },
		"claude:contradicted": {
			waiting_on: "user",
			ask: "Push and open a PR?",
			outcome: "done",
		},
	};
	const claude = fakeClaude((request) => {
		const id = Object.keys(answers).find((key) => request.input.includes(key));
		return { ...SUMMARY, ...answers[id ?? ""] };
	});
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	for (const id of Object.keys(answers)) {
		addSession(app, id);
		addEvents(app, id, [message("user", `Work on ${id}`, 0)]);
	}

	const report = await refreshSummaries(app);

	expect(storedSummary(app, "claude:offered")).toMatchObject({
		waitingOn: "user",
		ask: "Push and open a PR?",
	});
	expect(
		report.failures.toSorted((left, right) =>
			left.sessionId.localeCompare(right.sessionId),
		),
	).toEqual([
		{
			sessionId: "claude:contradicted",
			message: "Haiku returned outcome done while waiting_on is user",
		},
		{
			sessionId: "claude:unasked",
			message: "Haiku returned waiting_on user without an ask",
		},
		{
			sessionId: "claude:unlabeled",
			message: "Haiku returned an ask while waiting_on is none",
		},
	]);
});

test("a prompt over 100,000 tokens is reported, but a retried call whose prompts each stayed under is not", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:retried");
	addEvents(app, "claude:retried", [message("user", "Add summaries", 0)]);
	claude.inputTokens = 160_000;
	claude.largestPromptTokens = 80_000;
	const retried = await refreshSummaries(app);
	addSession(app, "claude:large");
	addEvents(app, "claude:large", [message("user", "Add summaries", 0)]);
	claude.inputTokens = 100_001;
	claude.largestPromptTokens = 100_001;

	const large = await refreshSummaries(app);

	expect(retried).toMatchObject({
		roots: { inputTokens: 160_000 },
		warnings: [],
	});
	expect(large.warnings).toEqual([
		{
			sessionId: "claude:large",
			message: expect.stringContaining("sent a 100001-token prompt"),
		},
	]);
	expect(large.failures).toEqual([]);
});

test("at most four calls run at once, and progress counts the sessions", async () => {
	let running = 0;
	let mostRunning = 0;
	const progress: string[] = [];
	const app = createTestApp({
		now: () => NOW,
		progress: (line) => progress.push(line),
		askClaude: async () => {
			running += 1;
			mostRunning = Math.max(mostRunning, running);
			await Bun.sleep(5);
			running -= 1;
			return {
				output: SUMMARY,
				inputTokens: 1_500,
				largestPromptTokens: 1_500,
			};
		},
	});
	for (const index of [1, 2, 3, 4, 5, 6]) {
		addSession(app, `claude:${index}`);
		addEvents(app, `claude:${index}`, [message("user", "Work", 0)]);
	}

	const report = await refreshSummaries(app);

	expect(report.roots.refreshed).toBe(6);
	expect(mostRunning).toBe(4);
	expect(progress).toEqual([
		"summarizing 1/6",
		"summarizing 2/6",
		"summarizing 3/6",
		"summarizing 4/6",
		"summarizing 5/6",
		"summarizing 6/6",
	]);
});

test("a summary that covers more events, written by another run meanwhile, is never replaced", async () => {
	const claude = fakeClaude();
	const app = createTestApp({ askClaude: claude.askClaude, now: () => NOW });
	addSession(app, "claude:root");
	addEvents(app, "claude:root", [message("user", "Add summaries", 0)]);
	claude.respond = () => {
		app.database
			.insert(summaries)
			.values({
				...storedRow("claude:root"),
				throughEventId: 1_000,
				objective: "newer",
			})
			.run();
		return SUMMARY;
	};

	await refreshSummaries(app);

	expect(storedSummary(app, "claude:root")?.objective).toBe("newer");
});

function fakeClaude(
	respond: (request: ClaudeRequest, index: number) => unknown = () => SUMMARY,
) {
	const claude = {
		requests: [] as ClaudeRequest[],
		inputTokens: 1_500,
		largestPromptTokens: 1_500,
		respond,
		askClaude: async (request: ClaudeRequest): Promise<ClaudeResponse> => {
			const index = claude.requests.push(request) - 1;
			return {
				output: claude.respond(request, index),
				inputTokens: claude.inputTokens,
				largestPromptTokens: claude.largestPromptTokens,
			};
		},
	};
	return claude;
}

function addSession(
	app: App,
	id: string,
	overrides: Partial<typeof sessions.$inferInsert> = {},
) {
	app.database
		.insert(sessions)
		.values({
			id,
			harness: "claude",
			surface: "unknown",
			parentId: null,
			title: null,
			cwd: "/work",
			branch: null,
			state: "ended",
			observedAt: AT,
			startedAt: AT,
			lastEventAt: AT,
			sourcePath: `/transcripts/${id}.jsonl`,
			readOffset: 0,
			...overrides,
		})
		.run();
}

function addEvents(app: App, sessionId: string, rows: EventInput[]): number[] {
	return rows.map((row) => {
		const inserted = app.database
			.insert(events)
			.values({ ...row, sessionId, key: `${sessionId}:${keyCount++}` })
			.returning({ id: events.id })
			.get();
		return inserted.id;
	});
}

function message(
	role: "user" | "assistant",
	text: string,
	minute: number,
): EventInput {
	return { role, text, at: minutesAfterStart(minute) };
}

function toolCall(
	text: string,
	target: string | null,
	status: ToolStatus,
	minute: number,
): EventInput {
	return {
		role: "tool",
		text,
		toolName: text.split(" ")[0] ?? text,
		toolTarget: target,
		toolStatus: status,
		at: minutesAfterStart(minute),
	};
}

function minutesAfterStart(minute: number): Date {
	return new Date(+AT + minute * 60_000);
}

function storedSummary(app: App, sessionId: string) {
	return app.database
		.select()
		.from(summaries)
		.where(eq(summaries.sessionId, sessionId))
		.get();
}

function storedRow(sessionId: string): typeof summaries.$inferInsert {
	return {
		sessionId,
		throughEventId: 1,
		objective: SUMMARY.objective,
		progress: "",
		tried: "",
		next: "",
		blockers: "",
		waitingOn: "none",
		ask: null,
		outcome: "in_progress",
		updatedAt: NOW,
	};
}

function order(text: string, parts: string[]): boolean {
	const positions = parts.map((part) => text.indexOf(part));
	return (
		positions.every((position) => position >= 0) &&
		positions.every(
			(position, index) =>
				index === 0 || position > (positions[index - 1] ?? 0),
		)
	);
}

type EventInput = Omit<typeof events.$inferInsert, "sessionId" | "key">;

let keyCount = 0;

const CHUNK_BYTES = 85_000 * 2 + 2_000;

const AT = new Date("2026-10-23T09:00:00.000Z");

const NOW = new Date("2026-10-23T12:00:00.000Z");

const SUMMARY = {
	objective: "Add rolling summaries",
	progress: ["Wrote src/summaries/index.ts", "bun test runs"],
	tried: [],
	next: ["Fix the chunk boundary"],
	blockers: [],
	waiting_on: "none",
	ask: null,
	outcome: "in_progress",
};

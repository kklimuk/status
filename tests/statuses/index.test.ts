import { expect, test } from "bun:test";
import type { App } from "@src/app";
import { events, sessions, summaries } from "@src/database";
import type { SessionState } from "@src/harnesses";
import {
	answerQuestion,
	rootsInWindow,
	type StatusRoot,
	writeBrief,
} from "@src/statuses";
import type { ClaudeRequest } from "@src/utils";
import { createTestApp } from "@tests/utils";

test("roots in the window fold in their subagents at any depth, newest family first", () => {
	const app = createTestApp();
	addSession(app, "claude:quiet", { minutesAgo: 60 });
	addSession(app, "claude:parent", { minutesAgo: 90, state: "idle" });
	addSession(app, "claude:child", {
		parentId: "claude:parent",
		minutesAgo: 90,
		state: "waiting",
	});
	addSummary(app, "claude:child", { objective: "Run the migration" });
	addSession(app, "claude:grandchild", {
		parentId: "claude:child",
		minutesAgo: 2,
		state: "busy",
	});
	addSession(app, "claude:old", { minutesAgo: 8 * 24 * 60 });

	const roots = rootsInWindow(app.database, SINCE);

	expect(roots.map((root) => root.session.id)).toEqual([
		"claude:parent",
		"claude:quiet",
	]);
	const [parent] = roots as [StatusRoot];
	expect(parent.lastActiveAt).toEqual(minutesBeforeNow(2));
	expect(parent.subagents.map((subagent) => subagent.id)).toEqual([
		"claude:child",
		"claude:grandchild",
	]);
	expect(parent.liveSubagents).toEqual([
		{ state: "waiting", objective: "Run the migration" },
		{ state: "busy", objective: "no summary yet" },
	]);
});

test("a summary is behind when its family has events past it, or when there is none", () => {
	const app = createTestApp();
	addSession(app, "claude:current", {});
	addSummary(app, "claude:current", {});
	addSession(app, "claude:moved", {});
	addSummary(app, "claude:moved", {});
	addSession(app, "claude:moved-child", { parentId: "claude:moved" });
	addEvent(app, "claude:moved-child");
	addSession(app, "claude:unsummarized", {});

	const roots = rootsInWindow(app.database, SINCE);

	expect(
		Object.fromEntries(roots.map((root) => [root.session.id, root.behind])),
	).toEqual({
		"claude:current": false,
		"claude:moved": true,
		"claude:unsummarized": true,
	});
});

test("the brief's input gives each root its live state, live subagents and summary", async () => {
	const requests: ClaudeRequest[] = [];
	const app = createTestApp({
		askClaude: async (request) => {
			requests.push(request);
			return answerWith({ goals: [goal({ sessions: ["claude:parent"] })] });
		},
	});
	addSession(app, "claude:parent", { state: "idle" });
	addSummary(app, "claude:parent", {
		progress: "Merged abc1234\nAdded 40 tests",
		waitingOn: "user",
		ask: "Ship it?",
	});
	addSession(app, "claude:child", {
		parentId: "claude:parent",
		state: "waiting",
	});
	addSummary(app, "claude:child", { objective: "Run the migration" });

	await writeBrief(app, rootsInWindow(app.database, SINCE), NOW);

	const request = requests[0] as ClaudeRequest;
	expect(request.model).toBe("claude-opus-5-5");
	expect(request.input).not.toContain("## claude:child");
	expect(request.input).toContain(
		[
			"## claude:parent",
			"live state: idle",
			"title: none",
			"directory: /work/repo",
			"branch: none",
			"last activity: 2026-10-23T11:55:00.000Z (5m ago)",
			"subagents: 1, 1 not ended",
			"- waiting subagent: Run the migration",
			"summary:",
			"objective: Objective of claude:parent",
			"progress:",
			"- Merged abc1234",
			"- Added 40 tests",
			"next: none",
			"blockers: none",
			"waiting on: user",
			"ask: Ship it?",
			"outcome: in_progress",
		].join("\n"),
	);
});

test("the brief keeps Opus's goal order and strips the list markers it adds", async () => {
	const app = createTestApp({
		askClaude: async () =>
			answerWith({
				goals: [
					goal({ name: "Second", status: "needs_you", sessions: ["claude:b"] }),
					goal({
						name: "First",
						status: "needs_you",
						done: ["- Merged the parser."],
						next: ["1. Start the test database.", "2) Rerun the test."],
						sessions: ["claude:a"],
					}),
				],
			}),
	});
	addSession(app, "claude:a", {});
	addSession(app, "claude:b", {});

	const brief = await writeBrief(app, rootsInWindow(app.database, SINCE), NOW);

	expect(brief.failure).toBeNull();
	expect(brief.ungrouped).toEqual([]);
	expect(brief.goals.map((entry) => entry.name)).toEqual(["Second", "First"]);
	expect(brief.goals[1]?.done).toEqual(["Merged the parser."]);
	expect(brief.goals[1]?.next).toEqual([
		"Start the test database.",
		"Rerun the test.",
	]);
});

test("an answer the brief can't trust fails closed and leaves every root ungrouped", async () => {
	const cases = [
		{
			goals: [goal({ status: "paused", sessions: ["claude:one"] })],
			failure:
				'the answer gives a status that isn\'t one of needs_you, running, finished: "paused"',
		},
		{
			goals: [goal({ sessions: ["claude:one", "claude:invented"] })],
			failure:
				"the answer names a session that wasn't asked about: claude:invented",
		},
		{
			goals: [
				goal({ sessions: ["claude:one"] }),
				goal({ sessions: ["claude:one"] }),
			],
			failure: "the answer lists claude:one more than once",
		},
	];
	for (const { goals, failure } of cases) {
		const app = createTestApp({ askClaude: async () => answerWith({ goals }) });
		addSession(app, "claude:one", {});

		const brief = await writeBrief(
			app,
			rootsInWindow(app.database, SINCE),
			NOW,
		);

		expect(brief.failure).toBe(failure);
		expect(brief.goals).toEqual([]);
		expect(brief.ungrouped.map((root) => root.session.id)).toEqual([
			"claude:one",
		]);
	}
});

test("a root the brief left out comes back ungrouped, without failing", async () => {
	const app = createTestApp({
		askClaude: async () =>
			answerWith({ goals: [goal({ sessions: ["claude:kept"] })] }),
	});
	addSession(app, "claude:kept", {});
	addSession(app, "claude:left", { minutesAgo: 10 });

	const brief = await writeBrief(app, rootsInWindow(app.database, SINCE), NOW);

	expect(brief.failure).toBeNull();
	expect(brief.goals.map((entry) => entry.sessions.length)).toEqual([1]);
	expect(brief.ungrouped.map((root) => root.session.id)).toEqual([
		"claude:left",
	]);
});

test("an answer to a question names each session once and fails closed on one it wasn't given", async () => {
	const answering = (ids: string[]) =>
		createTestApp({
			askClaude: async () =>
				answerWith({ answer: "Here is the answer.", sessions: ids }),
		});
	const app = answering(["claude:one", "claude:one"]);
	addSession(app, "claude:one", {});
	const invented = answering(["claude:invented"]);
	addSession(invented, "claude:one", {});

	const answered = await answerQuestion(
		app,
		rootsInWindow(app.database, SINCE),
		"what's running?",
		NOW,
	);
	const failed = await answerQuestion(
		invented,
		rootsInWindow(invented.database, SINCE),
		"what's running?",
		NOW,
	);

	expect(answered.failure).toBeNull();
	expect(answered.sessions.map((root) => root.session.id)).toEqual([
		"claude:one",
	]);
	expect(failed.failure).toBe(
		"the answer names a session that wasn't asked about: claude:invented",
	);
});

function addSession(
	app: App,
	id: string,
	options: { minutesAgo?: number; parentId?: string; state?: SessionState },
) {
	const lastEventAt = minutesBeforeNow(options.minutesAgo ?? 5);
	app.database
		.insert(sessions)
		.values({
			id,
			harness: "claude",
			surface: "unknown",
			parentId: options.parentId ?? null,
			title: null,
			cwd: "/work/repo",
			branch: null,
			state: options.state ?? "ended",
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

function addEvent(app: App, sessionId: string) {
	app.database
		.insert(events)
		.values({
			sessionId,
			key: `${sessionId}:1`,
			at: NOW,
			role: "user",
			text: "keep going",
		})
		.run();
}

function goal(fields: Record<string, unknown>) {
	return {
		name: "Work",
		status: "finished",
		goal: "What the work is.",
		done: [],
		blockers: [],
		next: [],
		sessions: [],
		...fields,
	};
}

function answerWith(output: unknown) {
	return { output, inputTokens: 0, largestPromptTokens: 0 };
}

function minutesBeforeNow(minutes: number): Date {
	return new Date(+NOW - minutes * 60_000);
}

const NOW = new Date("2026-10-23T12:00:00Z");

const SINCE = new Date(+NOW - 7 * 24 * 60 * 60_000);

import { expect, test } from "bun:test";
import type { App } from "@src/app";
import { events, sessions, summaries } from "@src/database";
import type { SessionState, ToolStatus } from "@src/harnesses";
import {
	filesEditedBy,
	listSessions,
	readCatalog,
	sessionsMatching,
} from "@src/summaries";
import { createTestApp } from "@tests/utils";
import { eq } from "drizzle-orm";

test("the live sessions are listed newest first, each subagent under its parent, and `all` adds the ended ones active since the cutoff", () => {
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
	addSession(app, "codex:ancient", { state: "ended", startedMinutesAgo: 600 });
	const catalog = readCatalog(app);

	const live = listSessions(catalog, filter({ all: false }));
	const all = listSessions(catalog, filter({ all: true }));

	expect(placement(live)).toEqual([
		["codex:other", 0],
		["claude:root", 0],
		["claude:helper", 1],
		["claude:nested", 2],
	]);
	expect(placement(all)).toEqual([
		["codex:other", 0],
		["claude:root", 0],
		["claude:helper", 1],
		["claude:nested", 2],
		["claude:done-helper", 1],
		["codex:old", 0],
	]);
});

test("a subagent under a hidden parent is placed under the nearest listed ancestor, and the hidden one's edits count there", () => {
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
	addEvents(app, "codex:root", [toolCall("Edit", "/work/root.ts", "ok", 9)]);
	addEvents(app, "codex:child", [
		toolCall("apply_patch", "/work/child.ts\n/work/other.ts", "ok", 6),
	]);
	addEvents(app, "codex:grandchild", [
		toolCall("Write", "/work/grandchild.ts", "ok", 3),
	]);

	const listed = listSessions(readCatalog(app), filter({ all: false }));

	expect(
		listed.map(({ session, depth, edited }) => [session.id, depth, edited]),
	).toEqual([
		["codex:root", 0, ["/work/child.ts", "/work/other.ts", "/work/root.ts"]],
		["codex:grandchild", 1, ["/work/grandchild.ts"]],
	]);
});

test("the callers are left out, their subagents move to the top level, and the callers' edits count for no one", () => {
	const app = testApp();
	addSession(app, "claude:self", { state: "busy", startedMinutesAgo: 50 });
	addSession(app, "claude:sibling", {
		parentId: "claude:self",
		state: "busy",
		startedMinutesAgo: 40,
	});
	addSession(app, "claude:sibling-helper", {
		parentId: "claude:sibling",
		state: "ended",
		startedMinutesAgo: 30,
	});
	addSession(app, "codex:thread-self", { state: "busy" });
	addEvents(app, "claude:self", [toolCall("Edit", "/work/self.ts", "ok", 4)]);
	addEvents(app, "claude:sibling-helper", [
		toolCall("Edit", "/work/sibling.ts", "ok", 3),
	]);

	const listed = listSessions(
		readCatalog(app),
		filter({ all: false, callers: ["claude:self", "codex:thread-self"] }),
	);

	expect(
		listed.map(({ session, depth, edited }) => [session.id, depth, edited]),
	).toEqual([["claude:sibling", 0, ["/work/sibling.ts"]]]);
});

test("edited files come from edit tools that weren't refused in the last 30 minutes, newest first, and a session's include its subagents'", () => {
	const app = testApp();
	addSession(app, "codex:root", { state: "busy" });
	addSession(app, "codex:child", { parentId: "codex:root", state: "busy" });
	addEvents(app, "codex:root", [
		toolCall("Edit", "/work/old.ts", "ok", 45),
		toolCall("Write", "/work/new.ts", "ok", 20),
		toolCall("apply_patch", "/work/a.ts\n/work/b.ts", "pending", 10),
		toolCall("Edit", "/work/denied.ts", "user_denied", 9),
		toolCall("Bash", "rm /work/c.ts", "ok", 8),
		toolCall("Edit", "/work/new.ts", "ok", 2),
	]);
	addEvents(app, "codex:child", [toolCall("Write", "/work/child.ts", "ok", 1)]);
	const catalog = readCatalog(app);

	expect(filesEditedBy(catalog, "codex:root")).toEqual([
		"/work/child.ts",
		"/work/new.ts",
		"/work/a.ts",
		"/work/b.ts",
	]);
	expect(filesEditedBy(catalog, "codex:child")).toEqual(["/work/child.ts"]);
});

test("a summary is behind when the newest event across its session and subagents is past it", () => {
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
	addSummary(app, "claude:root", [...rootIds, ...freshIds]);
	addSummary(app, "claude:fresh", freshIds);
	addSummary(app, "claude:helper", []);
	addEvents(app, "claude:helper", [message(1)]);

	const catalog = readCatalog(app);

	expect([...catalog.behind].sort()).toEqual(["claude:helper", "claude:root"]);
	expect(catalog.summaries.has("codex:new")).toBe(false);
});

test("an exact id matches only itself, and a prefix matches every id it starts, in id order", () => {
	const app = testApp();
	for (const id of [
		"claude:ac768d0a-2222",
		"claude:ac768d0a-1111",
		"claude:ac768d0a-1111-2",
		"codex:01a1",
	]) {
		addSession(app, id, { state: "ended" });
	}
	const idsMatching = (idOrPrefix: string) =>
		sessionsMatching(app.database, idOrPrefix).map((session) => session.id);

	expect(idsMatching("claude:ac768d0a-1111")).toEqual(["claude:ac768d0a-1111"]);
	expect(idsMatching("codex:0")).toEqual(["codex:01a1"]);
	expect(idsMatching("claude:ac768d0a")).toEqual([
		"claude:ac768d0a-1111",
		"claude:ac768d0a-1111-2",
		"claude:ac768d0a-2222",
	]);
	expect(idsMatching("claude:nope")).toEqual([]);
});

function testApp(): App {
	return createTestApp({ adapters: [], now: () => NOW });
}

function filter(options: { all: boolean; callers?: string[] }) {
	return {
		all: options.all,
		callers: new Set(options.callers ?? []),
		since: minutesAgo(180),
	};
}

function placement(listed: ReturnType<typeof listSessions>) {
	return listed.map(({ session, depth }) => [session.id, depth]);
}

function addSession(
	app: App,
	id: string,
	options: {
		parentId?: string;
		state: SessionState;
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
			title: null,
			cwd: "/work",
			branch: null,
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

function addSummary(app: App, sessionId: string, coveredIds: number[]) {
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
			updatedAt: NOW,
		})
		.run();
}

function message(minutes: number): EventFixture {
	return { at: minutesAgo(minutes), role: "assistant", text: "Working on it" };
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

type EventFixture = Omit<typeof events.$inferInsert, "sessionId" | "key">;

const NOW = new Date("2026-10-23T09:00:00Z");

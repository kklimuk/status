import { expect, onTestFinished, test } from "bun:test";
import { events, openDatabase, sessions } from "@src/database";
import { createTemporaryHome, createTestApp } from "@tests/utils";
import { join } from "path";

test("a fresh database creates its directory and runs in WAL mode", () => {
	const home = createTemporaryHome();

	const database = openDatabase(join(home.status, "nested", "status.db"));
	onTestFinished(() => database.$client.close());
	const row = database.$client
		.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
		.get();

	expect(row?.journal_mode).toBe("wal");
});

test("migrations create every table, whatever the working directory", () => {
	const home = createTemporaryHome();
	const workingDirectory = process.cwd();
	process.chdir(home.codex);
	onTestFinished(() => process.chdir(workingDirectory));

	const database = openDatabase(join(home.status, "status.db"));
	onTestFinished(() => database.$client.close());
	const tables = database.$client
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		)
		.all()
		.map((row) => row.name);

	expect(tables).toEqual(expect.arrayContaining(TABLES));
});

test("reopening a migrated database keeps its rows", () => {
	const home = createTemporaryHome();
	const path = join(home.status, "status.db");
	const first = openDatabase(path);
	first.insert(sessions).values(sessionRow("claude:one", "/one.jsonl")).run();
	first.$client.close();

	const second = openDatabase(path);
	onTestFinished(() => second.$client.close());

	expect(second.select().from(sessions).all()).toHaveLength(1);
});

test("times are stored as integer milliseconds", () => {
	const { database } = createTestApp();
	const startedAt = new Date("2026-10-23T09:15:00.123Z");

	database
		.insert(sessions)
		.values({ ...sessionRow("claude:one", "/one.jsonl"), startedAt })
		.run();
	const row = database.$client
		.query<{ started_at: number }, []>("SELECT started_at FROM sessions")
		.get();

	expect(row?.started_at).toBe(startedAt.getTime());
});

test("a source path belongs to one session", () => {
	const { database } = createTestApp();
	database
		.insert(sessions)
		.values(sessionRow("claude:one", "/same.jsonl"))
		.run();

	expect(() =>
		database
			.insert(sessions)
			.values(sessionRow("claude:two", "/same.jsonl"))
			.run(),
	).toThrow("UNIQUE constraint failed: sessions.source_path");
});

test("an event key is unique within its session but not across sessions", () => {
	const { database } = createTestApp();
	database
		.insert(sessions)
		.values([
			sessionRow("claude:one", "/one.jsonl"),
			sessionRow("claude:two", "/two.jsonl"),
		])
		.run();
	database
		.insert(events)
		.values([
			eventRow("claude:one", "call-1"),
			eventRow("claude:two", "call-1"),
		])
		.run();

	expect(() =>
		database.insert(events).values(eventRow("claude:one", "call-1")).run(),
	).toThrow("UNIQUE constraint failed: events.session_id, events.key");
});

test("an event must belong to a stored session", () => {
	const { database } = createTestApp();

	expect(() =>
		database.insert(events).values(eventRow("claude:missing", "call-1")).run(),
	).toThrow("FOREIGN KEY constraint failed");
});

test("a subagent can name a parent that was never ingested", () => {
	const { database } = createTestApp();

	database
		.insert(sessions)
		.values({
			...sessionRow("claude:agent-1", "/agent-1.jsonl"),
			parentId: "claude:outside-the-window",
		})
		.run();

	expect(database.select().from(sessions).all()).toHaveLength(1);
});

function sessionRow(
	id: string,
	sourcePath: string,
): typeof sessions.$inferInsert {
	return {
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
		sourcePath,
		readOffset: 0,
	};
}

function eventRow(sessionId: string, key: string): typeof events.$inferInsert {
	return {
		sessionId,
		key,
		at: AT,
		role: "tool",
		text: "Bash bun test",
		toolName: "Bash",
		toolTarget: "bun test",
		toolStatus: "pending",
	};
}

const TABLES = ["events", "sessions", "summaries"];

const AT = new Date("2026-10-23T09:00:00.000Z");

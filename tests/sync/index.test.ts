import { expect, test } from "bun:test";
import { events, sessions } from "@src/database";
import type {
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	ToolStatus,
} from "@src/harnesses";
import { sync } from "@src/sync";
import { createTestApp } from "@tests/utils";
import { asc, eq } from "drizzle-orm";

test("a first run stores each session and its events in the order read", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [
		message("m1", 1, "fix the build"),
		toolCall("c1", 2),
		message("m2", 3, "done"),
	]);
	const app = createTestApp({ adapters: [adapter] });

	const report = await sync(app, SINCE);

	expect(report).toEqual({
		sources: 1,
		sessions: 1,
		events: 3,
		warnings: [],
		failures: [],
	});
	expect(storedEvents(app).map((event) => event.key)).toEqual([
		"m1",
		"c1",
		"m2",
	]);
	expect(storedEvents(app)[1]).toMatchObject({
		role: "tool",
		toolName: "Bash",
		toolTarget: "bun test",
		toolStatus: "pending",
	});
	expect(storedSession(app, "claude:one")).toMatchObject({
		lastEventAt: atMinute(3),
		readOffset: 3,
		state: "ended",
	});
});

test("re-running changes nothing", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1), toolCall("c1", 2)]);
	adapter.write(record("claude:two"), [message("m1", 1), toolResult("c1", 3)]);
	adapter.live = [snapshot("claude:one", "busy")];
	const app = createTestApp({ adapters: [adapter], now: () => NOW });
	await sync(app, SINCE);
	const before = storedRows(app);

	const report = await sync(app, SINCE);

	expect(storedRows(app)).toEqual(before);
	expect(report.events).toBe(0);
});

test("a run resumes from the stored offset and appends in ingest order", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1), message("m2", 2)]);
	const app = createTestApp({ adapters: [adapter] });
	await sync(app, SINCE);

	adapter.append("claude:one", [message("m3", 3)]);
	const report = await sync(app, SINCE);

	expect(adapter.reads.at(-1)?.ingested).toEqual({
		session: record("claude:one"),
		readOffset: 2,
	});
	expect(report.events).toBe(1);
	const stored = storedEvents(app);
	expect(stored.map((event) => event.key)).toEqual(["m1", "m2", "m3"]);
	expect(stored[2]?.id).toBeGreaterThan(stored[1]?.id ?? Infinity);
	expect(storedSession(app, "claude:one")).toMatchObject({
		lastEventAt: atMinute(3),
		readOffset: 3,
	});
});

test("a tool result in a later run updates its pending call in place", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [toolCall("c1", 1)]);
	const app = createTestApp({ adapters: [adapter] });
	await sync(app, SINCE);
	const [call] = storedEvents(app);

	adapter.append("claude:one", [toolResult("c1", 2, "user_denied")]);
	await sync(app, SINCE);

	expect(storedEvents(app)).toEqual([
		{ ...call, toolStatus: "user_denied" } as typeof events.$inferSelect,
	]);
	expect(storedSession(app, "claude:one")?.lastEventAt).toEqual(atMinute(2));
});

test("re-reading a rewritten source never resets a finished call to pending", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [toolCall("c1", 1), toolResult("c1", 2)]);
	const app = createTestApp({ adapters: [adapter] });
	await sync(app, SINCE);

	adapter.rewrite("claude:one");
	await sync(app, SINCE);

	expect(storedEvents(app)).toHaveLength(1);
	expect(storedEvents(app)[0]?.toolStatus).toBe("ok");
});

test("a tool result without a stored call is dropped with a warning", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1), toolResult("c9", 2)]);
	const app = createTestApp({ adapters: [adapter] });

	const report = await sync(app, SINCE);

	expect(storedEvents(app).map((event) => event.key)).toEqual(["m1"]);
	expect(report.events).toBe(1);
	expect(report.warnings).toEqual([
		{
			harness: "claude",
			step: "read",
			source: "/sources/claude:one.jsonl",
			message: "tool result c9 has no stored call, so it was dropped",
		},
	]);
	expect(report.failures).toEqual([]);
});

test("subagents keep their parent link, even to a parent outside the window", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:parent"), [message("m1", 1)]);
	adapter.write({ ...record("claude:agent-1"), parentId: "claude:parent" }, [
		message("m1", 2),
	]);
	adapter.write(
		{ ...record("claude:agent-2"), parentId: "claude:outside-the-window" },
		[message("m1", 3)],
	);
	const app = createTestApp({ adapters: [adapter] });

	await sync(app, SINCE);
	await sync(app, SINCE);

	expect(storedSession(app, "claude:agent-1")?.parentId).toBe("claude:parent");
	expect(storedSession(app, "claude:agent-2")?.parentId).toBe(
		"claude:outside-the-window",
	);
});

test("the latest snapshot replaces the previous one, and a session it leaves out ends", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1)]);
	let now = atMinute(10);
	const app = createTestApp({ adapters: [adapter], now: () => now });

	adapter.live = [snapshot("claude:one", "busy", "/work/a", "main")];
	await sync(app, SINCE);
	expect(storedSession(app, "claude:one")).toMatchObject({
		state: "busy",
		cwd: "/work/a",
		branch: "main",
		observedAt: atMinute(10),
	});

	now = atMinute(20);
	adapter.live = [snapshot("claude:one", "idle", "/work/b", null)];
	await sync(app, SINCE);
	expect(storedSession(app, "claude:one")).toMatchObject({
		state: "idle",
		cwd: "/work/b",
		branch: null,
		observedAt: atMinute(20),
	});

	now = atMinute(30);
	adapter.live = [];
	await sync(app, SINCE);
	expect(storedSession(app, "claude:one")).toMatchObject({
		state: "ended",
		cwd: "/work/b",
		observedAt: atMinute(30),
	});

	now = atMinute(40);
	await sync(app, SINCE);
	expect(storedSession(app, "claude:one")?.observedAt).toEqual(atMinute(30));
});

test("the snapshot covers listed sources, the window and every session still marked live", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:live"), [message("m1", 1)]);
	adapter.write(record("claude:gone"), [message("m1", 1)]);
	adapter.write(record("claude:recent"), [message("m1", 100)]);
	adapter.write(record("claude:listed"), [message("m1", 1)]);
	const app = createTestApp({ adapters: [adapter] });
	adapter.live = [snapshot("claude:live", "idle")];
	await sync(app, atMinute(0));

	adapter.listSources = async () => [sourcePath("claude:listed")];
	await sync(app, atMinute(50));

	expect(adapter.snapshotRequests.at(-1)?.sort()).toEqual([
		"claude:listed",
		"claude:live",
		"claude:recent",
	]);
});

test("a failing adapter is reported while the others still sync", async () => {
	const broken = createFakeAdapter("codex");
	broken.listSources = async () => {
		throw new Error("not implemented");
	};
	const working = createFakeAdapter();
	working.write(record("claude:one"), [message("m1", 1)]);
	const app = createTestApp({ adapters: [broken, working] });

	const report = await sync(app, SINCE);

	expect(report.failures).toEqual([
		{
			harness: "codex",
			step: "list",
			source: null,
			message: "not implemented",
		},
	]);
	expect(report.sessions).toBe(1);
	expect(storedSession(app, "claude:one")).toBeDefined();
});

test("a source that fails to read stores nothing and the rest still sync", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:bad"), [message("m1", 1)]);
	adapter.write(record("claude:good"), [message("m1", 1)]);
	const readSource = adapter.readSource;
	adapter.readSource = async (path, ingested) => {
		if (path.includes("bad")) {
			throw new Error("unreadable");
		}
		return readSource(path, ingested);
	};
	const app = createTestApp({ adapters: [adapter] });

	const report = await sync(app, SINCE);

	expect(report.failures).toEqual([
		{
			harness: "claude",
			step: "read",
			source: "/sources/claude:bad.jsonl",
			message: "unreadable",
		},
	]);
	expect(storedSession(app, "claude:bad")).toBeUndefined();
	expect(storedSession(app, "claude:good")).toBeDefined();
});

test("a second source claiming a stored session id fails without moving it", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1)]);
	adapter.write({ ...record("claude:two"), id: "claude:one" }, [
		message("m2", 2),
	]);
	const app = createTestApp({ adapters: [adapter] });

	const report = await sync(app, SINCE);

	expect(report.failures).toHaveLength(1);
	expect(report.failures[0]?.message).toBe(
		"claude:one is already stored from /sources/claude:one.jsonl",
	);
	expect(storedEvents(app).map((event) => event.key)).toEqual(["m1"]);
	expect(storedSession(app, "claude:one")?.sourcePath).toBe(
		"/sources/claude:one.jsonl",
	);
});

test("a read that fails partway through storing rolls back its session row and events", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1)]);
	const app = createTestApp({ adapters: [adapter] });
	await sync(app, SINCE);

	adapter.append("claude:one", [
		message("m2", 2),
		{
			kind: "message",
			key: "m3",
			at: atMinute(3),
			role: "user",
			text: null as unknown as string,
		},
	]);
	const report = await sync(app, SINCE);

	expect(report.failures).toHaveLength(1);
	expect(report.sessions).toBe(0);
	expect(storedEvents(app).map((event) => event.key)).toEqual(["m1"]);
	expect(storedSession(app, "claude:one")).toMatchObject({
		lastEventAt: atMinute(1),
		readOffset: 1,
	});
});

test("a failed snapshot is reported and leaves every state as it was", async () => {
	const adapter = createFakeAdapter();
	adapter.write(record("claude:one"), [message("m1", 1)]);
	adapter.live = [snapshot("claude:one", "busy")];
	const app = createTestApp({ adapters: [adapter] });
	await sync(app, SINCE);

	adapter.snapshot = async () => {
		throw new Error("ps failed");
	};
	const report = await sync(app, SINCE);

	expect(report.failures).toEqual([
		{ harness: "claude", step: "snapshot", source: null, message: "ps failed" },
	]);
	expect(storedSession(app, "claude:one")?.state).toBe("busy");
});

test("an adapter's warnings are reported against their source", async () => {
	const adapter = createFakeAdapter("codex");
	adapter.write({ ...record("codex:one"), harness: "codex" }, [
		message("m1", 1),
	]);
	adapter.warnings = ["titles unavailable: state_5.sqlite is locked"];
	const app = createTestApp({ adapters: [adapter] });

	const report = await sync(app, SINCE);

	expect(report.warnings).toEqual([
		{
			harness: "codex",
			step: "read",
			source: "/sources/codex:one.jsonl",
			message: "titles unavailable: state_5.sqlite is locked",
		},
	]);
	expect(report.failures).toEqual([]);
});

function createFakeAdapter(harness: HarnessAdapter["harness"] = "claude") {
	const transcripts = new Map<
		string,
		{ session: SessionRecord; events: SessionEvent[]; rewritten: boolean }
	>();
	const adapter: FakeAdapter = {
		harness,
		live: [] as SessionSnapshot[],
		warnings: [] as string[],
		reads: [] as { path: string; ingested: IngestedSource | null }[],
		snapshotRequests: [] as string[][],
		write(session: SessionRecord, sessionEvents: SessionEvent[]) {
			transcripts.set(session.sourcePath, {
				session,
				events: sessionEvents,
				rewritten: false,
			});
		},
		append(id: string, sessionEvents: SessionEvent[]) {
			transcripts.get(sourcePath(id))?.events.push(...sessionEvents);
		},
		rewrite(id: string) {
			const transcript = transcripts.get(sourcePath(id));
			if (transcript) {
				transcript.rewritten = true;
			}
		},
		async listSources() {
			return [...transcripts.keys()];
		},
		async readSource(path: string, ingested: IngestedSource | null) {
			adapter.reads.push({ path, ingested });
			const transcript = transcripts.get(path);
			if (!transcript) {
				return null;
			}
			const resumed = ingested !== null && !transcript.rewritten;
			transcript.rewritten = false;
			return {
				session: resumed ? ingested.session : transcript.session,
				events: transcript.events.slice(resumed ? ingested.readOffset : 0),
				nextOffset: transcript.events.length,
				warnings: adapter.warnings,
			};
		},
		async snapshot(requested: SessionRecord[]) {
			adapter.snapshotRequests.push(requested.map((session) => session.id));
			return adapter.live;
		},
	};
	return adapter;
}

type FakeAdapter = HarnessAdapter & {
	live: SessionSnapshot[];
	warnings: string[];
	reads: { path: string; ingested: IngestedSource | null }[];
	snapshotRequests: string[][];
	write(session: SessionRecord, sessionEvents: SessionEvent[]): void;
	append(id: string, sessionEvents: SessionEvent[]): void;
	rewrite(id: string): void;
};

function record(id: string): SessionRecord {
	return {
		id,
		harness: "claude",
		surface: "unknown",
		parentId: null,
		title: null,
		cwd: "/work",
		branch: null,
		startedAt: atMinute(0),
		sourcePath: sourcePath(id),
	};
}

function sourcePath(id: string): string {
	return `/sources/${id}.jsonl`;
}

function message(key: string, minute: number, text = "hello"): SessionEvent {
	return { kind: "message", key, at: atMinute(minute), role: "user", text };
}

function toolCall(key: string, minute: number): SessionEvent {
	return {
		kind: "tool_call",
		key,
		at: atMinute(minute),
		text: "Bash bun test",
		toolName: "Bash",
		toolTarget: "bun test",
	};
}

function toolResult(
	key: string,
	minute: number,
	toolStatus: Exclude<ToolStatus, "pending"> = "ok",
): SessionEvent {
	return { kind: "tool_result", key, at: atMinute(minute), toolStatus };
}

function snapshot(
	sessionId: string,
	state: SessionSnapshot["state"],
	cwd = "/work",
	branch: string | null = null,
): SessionSnapshot {
	return { sessionId, state, cwd, branch };
}

function storedRows(app: ReturnType<typeof createTestApp>) {
	return {
		sessions: app.database
			.select()
			.from(sessions)
			.orderBy(asc(sessions.id))
			.all(),
		events: storedEvents(app),
	};
}

function storedEvents(app: ReturnType<typeof createTestApp>) {
	return app.database.select().from(events).orderBy(asc(events.id)).all();
}

function storedSession(app: ReturnType<typeof createTestApp>, id: string) {
	return app.database.select().from(sessions).where(eq(sessions.id, id)).get();
}

function atMinute(minute: number): Date {
	return new Date(START.getTime() + minute * 60_000);
}

const START = new Date("2026-10-23T09:00:00.000Z");

const SINCE = new Date("2026-10-16T09:00:00.000Z");

const NOW = new Date("2026-10-23T12:00:00.000Z");

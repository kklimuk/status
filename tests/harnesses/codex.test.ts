import { Database } from "bun:sqlite";
import { expect, onTestFinished, test } from "bun:test";
import {
	createCodexAdapter,
	type SessionEvent,
	type SessionRecord,
} from "@src/harnesses";
import { createTemporaryHome } from "@tests/utils";
import { closeSync, mkdirSync, openSync, rmSync, utimesSync } from "fs";
import { join } from "path";

const PARENT = "01a00000-0000-7000-8000-000000000001";
const CHILD = "01a00000-0000-7000-8000-000000000002";

test("listSources returns rollouts modified since the cutoff", async () => {
	const home = createTemporaryHome();
	const recent = await writeRollout(home.codex, PARENT, [meta(PARENT)]);
	const old = await writeRollout(home.codex, CHILD, [meta(CHILD)]);
	const lastWeek = new Date("2026-10-01T00:00:00Z");
	utimesSync(old, lastWeek, lastWeek);

	const sources = await createCodexAdapter(home.codex).listSources(
		new Date("2026-10-10T00:00:00Z"),
	);

	expect(sources).toEqual([recent]);
});

test("listSources returns nothing when Codex has no sessions folder", async () => {
	const home = createTemporaryHome();

	expect(await createCodexAdapter(home.codex).listSources(new Date(0))).toEqual(
		[],
	);
});

test("readSource builds the session from session_meta and state_5.sqlite", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, [
		{ id: PARENT, name: "Fix the parser", git_branch: "fix/parser" },
	]);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		line("turn_context", { cwd: "/work/repo/packages/core" }),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(read?.session).toEqual({
		id: `codex:${PARENT}`,
		harness: "codex",
		surface: "unknown",
		parentId: null,
		title: "Fix the parser",
		cwd: "/work/repo/packages/core",
		branch: "fix/parser",
		startedAt: new Date("2026-10-20T10:00:00.000Z"),
		sourcePath: path,
	});
	expect(read?.warnings).toEqual([]);
});

test("readSource reads a WAL state_5.sqlite that Codex has closed", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, [
		{ id: PARENT, name: "Fix the parser", git_branch: "fix/parser" },
	]);
	const statePath = join(home.codex, "state_5.sqlite");
	const state = new Database(statePath);
	state.run("PRAGMA journal_mode = WAL");
	state.close();
	rmSync(`${statePath}-wal`, { force: true });
	rmSync(`${statePath}-shm`, { force: true });
	const path = await writeRollout(home.codex, PARENT, [meta(PARENT)]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(read?.session.title).toBe("Fix the parser");
	expect(read?.warnings).toEqual([]);
});

test("message events hold only what the user and the assistant said", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		message("developer", "<permissions instructions>sandboxed</permissions>"),
		message(
			"user",
			"# AGENTS.md instructions for /work/repo\n\n<INSTRUCTIONS>",
		),
		message("user", "<environment_context>\n  <cwd>/work/repo</cwd>"),
		message("user", '<codex_internal_context source="goal">keep going'),
		message("user", [
			'<image name=[Image #1] path="/tmp/shot.png">',
			"</image>",
			"Why is this button misaligned? [Image #1]",
		]),
		message(
			"user",
			"\n# Chrome tabs:\n- Current URL: https://example.com\n\n## My request:\nsummarize this page\n",
		),
		line("response_item", { type: "reasoning", id: "rs_1", summary: [] }),
		message("assistant", "The flex container has no gap."),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(messages(read?.events)).toEqual([
		["user", "Why is this button misaligned? [Image #1]"],
		["user", "summarize this page"],
		["assistant", "The flex container has no gap."],
	]);
});

test("tool calls name the command or patched files they act on", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const patch =
		"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-x\\n+y\\n*** Add File: src/b.ts\\n+z\\n*** End Patch";
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		customCall(
			"call_1",
			'text(await tools.exec_command({cmd:"bun test tests/a.test.ts",max_output_tokens:1000}));',
		),
		customCall(
			"call_2",
			`const patch = "${patch}";\ntools.apply_patch(patch);`,
		),
		functionCall("call_3", "spawn_agent", { task_name: "reviewer" }),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(
		read?.events.map((event) =>
			event.kind === "tool_call"
				? [event.key, event.toolName, event.text, event.toolTarget]
				: null,
		),
	).toEqual([
		[
			"call_1",
			"exec_command",
			"exec_command bun test tests/a.test.ts",
			"bun test tests/a.test.ts",
		],
		["call_2", "apply_patch", "apply_patch src/a.ts", "src/a.ts\nsrc/b.ts"],
		["call_3", "spawn_agent", "spawn_agent reviewer", "reviewer"],
	]);
});

test("a single-quoted command is unescaped the way JavaScript reads it", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		customCall(
			"call_1",
			String.raw`tools.exec_command({cmd:'printf "a\\nb\tc"'})`,
		),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(read?.events).toEqual([
		expect.objectContaining({ toolTarget: 'printf "a\\nb\tc"' }),
	]);
});

test("tool results reuse the call's key and carry ok, error, user_denied or auto_denied", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		customOutput("ok", scriptOutput("Script completed", { exit_code: 0 })),
		customOutput("exit", scriptOutput("Script completed", { exit_code: 1 })),
		customOutput("failed", scriptOutput("Script failed", "Script error: boom")),
		customOutput(
			"guardian",
			scriptOutput(
				"Script failed",
				'Script error:\nexec_command failed for `rm -rf build`: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\nReason: too broad.\\")" }',
			),
		),
		customOutput("after-output", [
			...scriptOutput("Script failed", "build/ removed from the index"),
			{
				type: "input_text",
				text: 'Script error:\nexec_command failed for `rm -rf build`: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\")" }',
			},
		]),
		customOutput(
			"user-cell",
			scriptOutput(
				"Script failed",
				'Script error:\nexec_command failed for `git push`: CreateProcess { message: "Rejected(\\"exec command rejected by user\\")" }',
			),
		),
		functionOutput(
			"guardian-function",
			'Rejected("This action was rejected due to unacceptable risk.")',
		),
		functionOutput("user", "exec command rejected by user"),
		functionOutput("patch", "patch rejected by user"),
		functionOutput("mcp", "user rejected MCP tool call"),
		functionOutput("aborted", "aborted by user after 3.2s"),
		functionOutput("wait", '{"message":"Wait completed.","timed_out":false}'),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(
		read?.events.map((event) =>
			event.kind === "tool_result" ? [event.key, event.toolStatus] : null,
		),
	).toEqual([
		["ok", "ok"],
		["exit", "error"],
		["failed", "error"],
		["guardian", "auto_denied"],
		["after-output", "auto_denied"],
		["user-cell", "user_denied"],
		["guardian-function", "auto_denied"],
		["user", "user_denied"],
		["patch", "user_denied"],
		["mcp", "user_denied"],
		["aborted", "error"],
		["wait", "ok"],
	]);
});

test("refusal text inside a command or its output is not a refusal", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		customOutput(
			"command",
			scriptOutput(
				"Script failed",
				"Script error:\nexec_command failed for `grep 'patch rejected by user' log`: CreateProcess { message: \"spawn failed\" }",
			),
		),
		customOutput(
			"output",
			scriptOutput("Script completed", {
				exit_code: 1,
				output: "This action was rejected due to unacceptable risk",
			}),
		),
		functionOutput(
			"function",
			"git push failed\nremote: exec command rejected by user",
		),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(
		read?.events.map((event) =>
			event.kind === "tool_result" ? [event.key, event.toolStatus] : null,
		),
	).toEqual([
		["command", "error"],
		["output", "error"],
		["function", "error"],
	]);
});

test("guardian review threads are skipped", async () => {
	const home = createTemporaryHome();
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT, { thread_source: "guardian_review" }),
		message("user", "assess this action"),
	]);

	expect(
		await createCodexAdapter(home.codex).readSource(path, null),
	).toBeNull();
});

test("a rollout without a complete first line isn't ingested yet", async () => {
	const home = createTemporaryHome();
	const path = await writeRollout(home.codex, PARENT, []);
	await Bun.write(path, JSON.stringify(meta(PARENT)).slice(0, 40));

	expect(
		await createCodexAdapter(home.codex).readSource(path, null),
	).toBeNull();
});

test("reads resume from the offset and leave a half-written line for later", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const adapter = createCodexAdapter(home.codex);
	const call = customCall("call_1", 'tools.exec_command({cmd:"ls"})');
	const output = customOutput("call_1", scriptOutput("Script completed", {}));
	const path = await writeRollout(home.codex, PARENT, [meta(PARENT), call]);
	const complete = Bun.file(path).size;
	await appendText(path, JSON.stringify(output).slice(0, 30));

	const first = await adapter.readSource(path, null);
	if (!first) {
		throw new Error("expected a first read");
	}
	await Bun.write(path, linesText([meta(PARENT), call, output]));
	const second = await adapter.readSource(path, {
		session: first.session,
		readOffset: first.nextOffset,
	});

	expect(first.nextOffset).toBe(complete);
	expect(first.events.map((event) => event.kind)).toEqual(["tool_call"]);
	expect(second?.events).toEqual([
		{ kind: "tool_result", key: "call_1", at: AT, toolStatus: "ok" },
	]);
	expect(second?.nextOffset).toBe(Bun.file(path).size);
});

test("a rewritten rollout shorter than the offset is read again from the start", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const adapter = createCodexAdapter(home.codex);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		message("user", "hello"),
	]);
	const first = await adapter.readSource(path, null);
	if (!first) {
		throw new Error("expected a first read");
	}

	const second = await adapter.readSource(path, {
		session: first.session,
		readOffset: first.nextOffset + 1000,
	});

	expect(messages(second?.events)).toEqual([["user", "hello"]]);
});

test("without state_5.sqlite the read keeps the stored title and says why", async () => {
	const home = createTemporaryHome();
	const path = await writeRollout(home.codex, PARENT, [meta(PARENT)]);
	const stored: SessionRecord = {
		id: `codex:${PARENT}`,
		harness: "codex",
		surface: "unknown",
		parentId: null,
		title: "Earlier title",
		cwd: "/work/repo",
		branch: "main",
		startedAt: new Date("2026-10-20T10:00:00.000Z"),
		sourcePath: path,
	};

	const read = await createCodexAdapter(home.codex).readSource(path, {
		session: stored,
		readOffset: 0,
	});

	expect(read?.session.title).toBe("Earlier title");
	expect(read?.session.branch).toBe("main");
	expect(read?.warnings).toEqual([
		expect.stringContaining("couldn't read the title and branch"),
	]);
});

test("a subagent links to its parent and leaves out the history it forked", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, CHILD, [
		meta(CHILD, {
			source: {
				subagent: {
					thread_spawn: { parent_thread_id: PARENT, agent_path: "/root/x" },
				},
			},
			thread_source: "subagent",
			subagent_history_start_ordinal: 3,
		}),
		meta(PARENT),
		message("user", "the parent's own request"),
		line("response_item", {
			type: "agent_message",
			id: "amsg_1",
			author: "/root",
			recipient: "/root/x",
			content: [
				{
					type: "input_text",
					text: "Message Type: NEW_TASK\nTask name: /root/x\nPayload:\n",
				},
				{ type: "encrypted_content", encrypted_content: "gAAAA" },
			],
		}),
		message("assistant", "Reviewed: no issues."),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(read?.session.id).toBe(`codex:${CHILD}`);
	expect(read?.session.parentId).toBe(`codex:${PARENT}`);
	expect(messages(read?.events)).toEqual([
		[
			"user",
			"Message Type: NEW_TASK\nTask name: /root/x\nPayload:\n[encrypted payload]",
		],
		["assistant", "Reviewed: no issues."],
	]);
});

test("a root session ignores messages other agents send it", async () => {
	const home = createTemporaryHome();
	writeStateDatabase(home.codex, []);
	const path = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		line("response_item", {
			type: "agent_message",
			id: "amsg_1",
			author: "/root/x",
			recipient: "/root",
			content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER" }],
		}),
	]);

	const read = await createCodexAdapter(home.codex).readSource(path, null);

	expect(read?.events).toEqual([]);
});

test("snapshot reports threads whose writer lock is held, busy until the turn ends", async () => {
	const home = createTemporaryHome();
	const busy = await writeRollout(home.codex, PARENT, [
		meta(PARENT),
		line("event_msg", { type: "task_started" }),
		line("turn_context", { cwd: "/work/repo/live" }),
	]);
	const idle = await writeRollout(home.codex, CHILD, [
		meta(CHILD),
		line("event_msg", { type: "task_started" }),
		line("event_msg", { type: "task_complete" }),
	]);
	const ended = "01a00000-0000-7000-8000-000000000003";
	const endedPath = await writeRollout(home.codex, ended, [meta(ended)]);
	holdLock(home.codex, PARENT);
	holdLock(home.codex, CHILD);
	await Bun.write(join(home.codex, "thread-writer-locks", `${ended}.lock`), "");

	const snapshots = await createCodexAdapter(home.codex).snapshot([
		record(PARENT, busy),
		record(CHILD, idle),
		record(ended, endedPath),
	]);

	expect(snapshots).toEqual([
		{
			sessionId: `codex:${PARENT}`,
			state: "busy",
			cwd: "/work/repo/live",
			branch: "main",
		},
		{
			sessionId: `codex:${CHILD}`,
			state: "idle",
			cwd: "/work/repo",
			branch: "main",
		},
	]);
});

test("snapshot is empty when no thread holds a lock", async () => {
	const home = createTemporaryHome();

	expect(await createCodexAdapter(home.codex).snapshot([])).toEqual([]);
});

function meta(id: string, overrides: Record<string, unknown> = {}) {
	return {
		timestamp: "2026-10-20T10:00:00.000Z",
		type: "session_meta",
		payload: {
			id,
			timestamp: "2026-10-20T10:00:00.000Z",
			cwd: "/work/repo",
			source: "cli",
			thread_source: "user",
			...overrides,
		},
	};
}

function line(type: string, payload: Record<string, unknown>) {
	return { timestamp: AT.toISOString(), type, payload };
}

function message(role: string, text: string | string[]) {
	const texts = typeof text === "string" ? [text] : text;
	return line("response_item", {
		type: "message",
		id: `msg_${role}_${texts.join("").length}`,
		role,
		content: texts.map((part) => ({
			type: role === "assistant" ? "output_text" : "input_text",
			text: part,
		})),
	});
}

function customCall(callId: string, input: string) {
	return line("response_item", {
		type: "custom_tool_call",
		call_id: callId,
		name: "exec",
		input,
	});
}

function functionCall(
	callId: string,
	name: string,
	parameters: Record<string, unknown>,
) {
	return line("response_item", {
		type: "function_call",
		call_id: callId,
		name,
		namespace: "collaboration",
		arguments: JSON.stringify(parameters),
	});
}

function customOutput(callId: string, output: unknown) {
	return line("response_item", {
		type: "custom_tool_call_output",
		call_id: callId,
		output,
	});
}

function functionOutput(callId: string, output: string) {
	return line("response_item", {
		type: "function_call_output",
		call_id: callId,
		output,
	});
}

function scriptOutput(
	header: string,
	result: string | Record<string, unknown>,
) {
	return [
		{ type: "input_text", text: `${header}\nWall time 0.1 seconds\nOutput:\n` },
		{
			type: "input_text",
			text: typeof result === "string" ? result : JSON.stringify(result),
		},
	];
}

async function writeRollout(
	codex: string,
	threadId: string,
	lines: object[],
): Promise<string> {
	const directory = join(codex, "sessions", "2026", "10", "20");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `rollout-2026-10-20T10-00-00-${threadId}.jsonl`);
	await Bun.write(path, linesText(lines));
	return path;
}

function linesText(lines: object[]): string {
	return lines
		.map((entry, ordinal) => `${JSON.stringify({ ...entry, ordinal })}\n`)
		.join("");
}

async function appendText(path: string, text: string) {
	await Bun.write(path, (await Bun.file(path).text()) + text);
}

function writeStateDatabase(
	codex: string,
	threads: { id: string; name: string; git_branch: string | null }[],
) {
	const database = new Database(join(codex, "state_5.sqlite"));
	database.run(
		"CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, git_branch TEXT)",
	);
	for (const thread of threads) {
		database.run("INSERT INTO threads VALUES (?, ?, ?)", [
			thread.id,
			thread.name,
			thread.git_branch,
		]);
	}
	database.close();
}

function holdLock(codex: string, threadId: string) {
	const directory = join(codex, "thread-writer-locks");
	mkdirSync(directory, { recursive: true });
	const descriptor = openSync(join(directory, `${threadId}.lock`), "w");
	onTestFinished(() => closeSync(descriptor));
}

function record(threadId: string, sourcePath: string): SessionRecord {
	return {
		id: `codex:${threadId}`,
		harness: "codex",
		surface: "unknown",
		parentId: null,
		title: null,
		cwd: "/work/repo",
		branch: "main",
		startedAt: new Date("2026-10-20T10:00:00.000Z"),
		sourcePath,
	};
}

function messages(events: SessionEvent[] | undefined) {
	return (events ?? []).flatMap((event) =>
		event.kind === "message" ? [[event.role, event.text]] : [],
	);
}

const AT = new Date("2026-10-20T10:05:00.000Z");

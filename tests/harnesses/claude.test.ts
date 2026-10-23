import { expect, test } from "bun:test";
import { createClaudeAdapter, type SessionRecord } from "@src/harnesses";
import { createTemporaryHome } from "@tests/utils";
import { mkdirSync, symlinkSync, utimesSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname, join } from "path";

test("listSources finds root and subagent transcripts modified since the cutoff", async () => {
	const { claude } = createTemporaryHome();
	const project = join(claude, "projects", "-work-repo");
	const root = join(project, `${SESSION_ID}.jsonl`);
	const subagent = join(project, SESSION_ID, "subagents", "agent-a1.jsonl");
	const workflowAgent = join(
		project,
		SESSION_ID,
		"subagents",
		"workflows",
		"wf_1",
		"agent-a2.jsonl",
	);
	const stale = join(project, "stale.jsonl");
	for (const path of [root, subagent, workflowAgent, stale]) {
		await writeLines(path, [userLine({ text: "hello" })]);
	}
	await writeLines(
		join(
			project,
			SESSION_ID,
			"subagents",
			"workflows",
			"wf_1",
			"journal.jsonl",
		),
		[{}],
	);
	symlinkSync(
		subagent,
		join(project, SESSION_ID, "subagents", "agent-a3.jsonl"),
	);
	setModified(stale, new Date("2026-01-01T00:00:00Z"));

	const sources = await createClaudeAdapter(claude).listSources(
		new Date("2026-06-01T00:00:00Z"),
	);

	expect(sources.sort()).toEqual([root, subagent, workflowAgent].sort());
});

test("listSources returns nothing when Claude has no projects directory", async () => {
	const { claude } = createTemporaryHome();

	expect(await createClaudeAdapter(claude).listSources(new Date(0))).toEqual(
		[],
	);
});

test("a root transcript yields a record as of its last line", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		{ type: "mode", sessionId: SESSION_ID },
		userLine({ text: "build the thing", at: "2026-10-23T09:00:00.000Z" }),
		{ type: "ai-title", aiTitle: "First title", sessionId: SESSION_ID },
		assistantLine([{ type: "text", text: "on it" }], {
			cwd: "/work/repo/.worktrees/feature",
			gitBranch: "feature",
		}),
		{ type: "ai-title", aiTitle: "Better title", sessionId: SESSION_ID },
	]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.session).toEqual({
		id: `claude:${SESSION_ID}`,
		harness: "claude",
		surface: "unknown",
		parentId: null,
		title: "Better title",
		cwd: "/work/repo/.worktrees/feature",
		branch: "feature",
		startedAt: new Date("2026-10-23T09:00:00.000Z"),
		sourcePath: path,
	});
	expect(read?.nextOffset).toBe(Bun.file(path).size);
	expect(read?.warnings).toEqual([]);
});

test("a detached HEAD is recorded as no branch", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [userLine({ text: "hi", gitBranch: "HEAD" })]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.session.branch).toBeNull();
});

test("a subagent is its own session, titled by its description and linked to its parent", async () => {
	const { claude } = createTemporaryHome();
	const path = join(
		claude,
		"projects",
		"-work-repo",
		SESSION_ID,
		"subagents",
		"agent-a1.jsonl",
	);
	await writeLines(path, [
		userLine({ text: "review the diff", agentId: "a1", isSidechain: true }),
	]);
	await Bun.write(
		path.replace(/\.jsonl$/, ".meta.json"),
		JSON.stringify({ agentType: "general-purpose", description: "Review" }),
	);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.session.id).toBe("claude:a1");
	expect(read?.session.parentId).toBe(`claude:${SESSION_ID}`);
	expect(read?.session.title).toBe("Review");
	expect(read?.events).toMatchObject([
		{ kind: "message", role: "user", text: "review the diff" },
	]);
});

test("scripted claude -p transcripts are skipped", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		{ type: "queue-operation", sessionId: SESSION_ID, timestamp: AT },
		userLine({ text: "summarize", entrypoint: "sdk-cli" }),
	]);

	expect(await createClaudeAdapter(claude).readSource(path, null)).toBeNull();
});

test("a transcript without a complete conversation line yet is not ingested", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [{ type: "mode", sessionId: SESSION_ID }]);
	await appendFile(path, JSON.stringify(userLine({ text: "half" })));

	expect(await createClaudeAdapter(claude).readSource(path, null)).toBeNull();
});

test("a half-written line waits for the next read, which carries the record forward", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	const adapter = createClaudeAdapter(claude);
	await writeLines(path, [
		userLine({ text: "first", uuid: "u1" }),
		{ type: "ai-title", aiTitle: "Kept title", sessionId: SESSION_ID },
	]);
	const completeSize = Bun.file(path).size;
	const second = JSON.stringify(
		assistantLine([{ type: "text", text: "second" }], { uuid: "u2" }),
	);
	await appendFile(path, second.slice(0, 20));

	const first = await adapter.readSource(path, null);
	await appendFile(path, `${second.slice(20)}\n`);
	const next = await adapter.readSource(path, {
		session: first?.session as SessionRecord,
		readOffset: first?.nextOffset ?? 0,
	});

	expect(first?.nextOffset).toBe(completeSize);
	expect(first?.events.map((event) => event.key)).toEqual(["u1"]);
	expect(next?.events).toMatchObject([
		{ kind: "message", key: "u2", role: "assistant", text: "second" },
	]);
	expect(next?.session.title).toBe("Kept title");
	expect(next?.nextOffset).toBe(Bun.file(path).size);
});

test("a file shorter than the stored offset is read again from the start", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	const adapter = createClaudeAdapter(claude);
	await writeLines(path, [userLine({ text: "rewritten", uuid: "u1" })]);
	const first = await adapter.readSource(path, null);

	const again = await adapter.readSource(path, {
		session: first?.session as SessionRecord,
		readOffset: 10_000,
	});

	expect(again?.events.map((event) => event.key)).toEqual(["u1"]);
});

test("unparseable lines are skipped with a warning", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [userLine({ text: "hi" })]);
	await appendFile(path, "{not json\n");

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.events).toHaveLength(1);
	expect(read?.warnings).toEqual([`skipped 1 unparseable lines in ${path}`]);
});

test("tool calls become headlines, and their results carry ok, error or denied", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		userLine({ text: "go" }),
		assistantLine([{ type: "thinking", thinking: "hmm" }]),
		assistantLine([
			toolUse("t1", "Bash", { command: "bun test\nbun run check" }),
		]),
		assistantLine([toolUse("t2", "Edit", { file_path: "/work/a.ts" })]),
		assistantLine([toolUse("t3", "Write", { file_path: "/work/b.ts" })]),
		assistantLine([toolUse("t4", "TaskStop", { task_id: "x" })]),
		toolResultLine("t1", { content: "ok" }),
		toolResultLine("t2", { is_error: true, content: "String not found" }),
		toolResultLine("t3", {
			is_error: true,
			content: [
				{
					type: "text",
					text: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
				},
			],
		}),
		toolResultLine("t4", {
			is_error: true,
			content:
				"The user doesn't want to take this action right now. STOP what you are doing.",
		}),
	]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.events.slice(1)).toMatchObject([
		{
			kind: "tool_call",
			key: "t1",
			text: "Bash bun test",
			toolName: "Bash",
			toolTarget: "bun test\nbun run check",
		},
		{ kind: "tool_call", key: "t2", text: "Edit /work/a.ts" },
		{ kind: "tool_call", key: "t3", text: "Write /work/b.ts" },
		{ kind: "tool_call", key: "t4", text: "TaskStop", toolTarget: null },
		{ kind: "tool_result", key: "t1", toolStatus: "ok" },
		{ kind: "tool_result", key: "t2", toolStatus: "error" },
		{ kind: "tool_result", key: "t3", toolStatus: "denied" },
		{ kind: "tool_result", key: "t4", toolStatus: "denied" },
	]);
});

test("an automatic permission denial is an error, not a user rejection", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		assistantLine([toolUse("t1", "Bash", { command: "cat ~/.ssh/id" })]),
		toolResultLine("t1", {
			is_error: true,
			content:
				"Permission for this action was denied by the Claude Code auto mode classifier.",
		}),
	]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.events[1]).toMatchObject({ toolStatus: "error" });
});

test("only what the user or the assistant actually said becomes a message", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		userLine({
			text: "<local-command-caveat>Caveat</local-command-caveat>",
			isMeta: true,
		}),
		userLine({ text: "<command-name>/login</command-name>" }),
		userLine({
			text: "<local-command-stdout>Login successful</local-command-stdout>",
		}),
		userLine({ text: "<bash-input>ls</bash-input>" }),
		userLine({
			text: "the real objective",
			uuid: "objective",
			origin: { kind: "human" },
		}),
		userLine({ text: "# Skill instructions", isMeta: true }),
		userLine({ text: "<system-reminder>hint</system-reminder>", isMeta: true }),
		userLine({
			text: "This session is being continued…",
			isCompactSummary: true,
		}),
		userLine({
			text: "Another session sent a message",
			isMeta: true,
			origin: { kind: "peer" },
		}),
		userLine({
			text: "<task-notification>done</task-notification>",
			origin: { kind: "task-notification" },
		}),
		userLine({
			uuid: "blocks",
			origin: { kind: "human" },
			blocks: [
				{ type: "text", text: "<ide_opened_file>a.ts</ide_opened_file>" },
				{ type: "text", text: "look at this file" },
			],
		}),
		userLine({
			blocks: [{ type: "text", text: "[Request interrupted by user]\n" }],
		}),
		userLine({
			uuid: "rejected",
			blocks: [
				{ type: "text", text: "[Request interrupted by user for tool use]" },
			],
		}),
		{
			type: "attachment",
			uuid: "queued",
			sessionId: SESSION_ID,
			timestamp: AT,
			attachment: {
				type: "queued_command",
				commandMode: "prompt",
				origin: { kind: "human" },
				prompt: "also handle the edge case",
			},
		},
		{
			type: "attachment",
			uuid: "queued-notification",
			sessionId: SESSION_ID,
			timestamp: AT,
			attachment: {
				type: "queued_command",
				commandMode: "task-notification",
				origin: { kind: "task-notification" },
				prompt: "<task-notification>",
			},
		},
		assistantLine([{ type: "text", text: "API Error: Connection lost" }], {
			isApiErrorMessage: true,
		}),
		assistantLine([{ type: "text", text: "Done." }], { uuid: "reply" }),
	]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(
		read?.events.map((event) =>
			event.kind === "message" ? [event.key, event.role, event.text] : [],
		),
	).toEqual([
		["objective", "user", "the real objective"],
		["blocks", "user", "look at this file"],
		["rejected", "user", "[Request interrupted by user for tool use]"],
		["queued", "user", "also handle the edge case"],
		["reply", "assistant", "Done."],
	]);
});

test("a queued prompt written as content blocks keeps its text", async () => {
	const { claude } = createTemporaryHome();
	const path = transcriptPath(claude);
	await writeLines(path, [
		userLine({ text: "start" }),
		{
			type: "attachment",
			uuid: "queued",
			sessionId: SESSION_ID,
			timestamp: AT,
			attachment: {
				type: "queued_command",
				commandMode: "prompt",
				origin: { kind: "human" },
				prompt: [
					{ type: "text", text: "and this screenshot" },
					{ type: "image", source: { type: "base64", data: "" } },
				],
			},
		},
	]);

	const read = await createClaudeAdapter(claude).readSource(path, null);

	expect(read?.events[1]).toMatchObject({
		kind: "message",
		key: "queued",
		role: "user",
		text: "and this screenshot",
	});
});

test("snapshot reports live root sessions with their state, directory and branch", async () => {
	const { claude, codex } = createTemporaryHome();
	const repo = await createRepository(codex, "feature");
	const deadPid = await exitedPid();
	await writeSessionFile(claude, 1, { sessionId: "busy", status: "busy" });
	await writeSessionFile(claude, 2, { sessionId: "shell", status: "shell" });
	await writeSessionFile(claude, 3, {
		sessionId: "waiting",
		status: "waiting",
	});
	await writeSessionFile(claude, 4, {
		sessionId: "job",
		kind: "bg",
		status: "idle",
	});
	await writeSessionFile(claude, 5, {
		sessionId: "scripted",
		entrypoint: "sdk-cli",
	});
	await writeSessionFile(claude, 6, { sessionId: "daemon", kind: "daemon" });
	await writeSessionFile(claude, 7, { sessionId: "dead", pid: deadPid });
	await Bun.write(join(claude, "sessions", "8.json"), "{torn");
	await writeSessionFile(claude, 9, { sessionId: "zero", pid: 0 });
	await writeSessionFile(claude, 10, {
		sessionId: "agent-sdk",
		entrypoint: "sdk-ts",
	});
	await writeSessionFile(claude, 11, {
		sessionId: "parked",
		parkedJobId: "job",
	});
	const sessions = [
		"busy",
		"shell",
		"waiting",
		"job",
		"scripted",
		"daemon",
		"dead",
		"zero",
		"agent-sdk",
		"parked",
		"gone",
	].map((id) =>
		record({ id: `claude:${id}`, cwd: id === "busy" ? repo : "/nowhere" }),
	);

	const snapshot = await createClaudeAdapter(claude).snapshot(sessions);

	expect(snapshot).toEqual([
		{ sessionId: "claude:busy", state: "busy", cwd: repo, branch: "feature" },
		{ sessionId: "claude:shell", state: "busy", cwd: "/nowhere", branch: null },
		{
			sessionId: "claude:waiting",
			state: "idle",
			cwd: "/nowhere",
			branch: null,
		},
		{ sessionId: "claude:job", state: "idle", cwd: "/nowhere", branch: null },
	]);
});

test("a subagent is busy while its parent is live and its transcript changed in the last 2 minutes", async () => {
	const { claude, codex } = createTemporaryHome();
	const repo = await createRepository(codex, "stream");
	await writeSessionFile(claude, 1, { sessionId: "parent", status: "idle" });
	const subagent = async (
		name: string,
		options: { modified?: Date; finished?: boolean } = {},
	) => {
		const path = join(
			claude,
			"projects",
			"-repo",
			"parent",
			"subagents",
			`agent-${name}.jsonl`,
		);
		await writeLines(path, [userLine({ text: "task" })]);
		if (options.modified) {
			setModified(path, options.modified);
		}
		if (options.finished) {
			await Bun.write(
				path.replace(/\.jsonl$/, ".meta.json"),
				JSON.stringify({ finished: true }),
			);
		}
		return record({
			id: `claude:${name}`,
			parentId: "claude:parent",
			cwd: repo,
			sourcePath: path,
		});
	};
	const sessions = [
		await subagent("running"),
		await subagent("quiet", { modified: new Date(Date.now() - 3 * 60_000) }),
		await subagent("finished", { finished: true }),
		record({
			id: "claude:orphan",
			parentId: "claude:ended-parent",
			sourcePath: "/nowhere.jsonl",
		}),
	];

	const snapshot = await createClaudeAdapter(claude).snapshot(sessions);

	expect(snapshot).toEqual([
		{ sessionId: "claude:running", state: "busy", cwd: repo, branch: "stream" },
	]);
});

test("a live session without a directory has no branch, not the branch status runs from", async () => {
	const { claude } = createTemporaryHome();
	await writeSessionFile(claude, 1, { sessionId: "rootless" });

	const snapshot = await createClaudeAdapter(claude).snapshot([
		record({ id: "claude:rootless", cwd: "" }),
	]);

	expect(snapshot).toEqual([
		{ sessionId: "claude:rootless", state: "idle", cwd: "", branch: null },
	]);
});

function transcriptPath(claude: string): string {
	return join(claude, "projects", "-work-repo", `${SESSION_ID}.jsonl`);
}

async function writeLines(path: string, entries: object[]) {
	mkdirSync(dirname(path), { recursive: true });
	await Bun.write(
		path,
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);
}

function setModified(path: string, time: Date) {
	utimesSync(path, time, time);
}

function userLine(options: {
	text?: string;
	blocks?: object[];
	uuid?: string;
	at?: string;
	[field: string]: unknown;
}) {
	const { text, blocks, uuid, at, ...fields } = options;
	return {
		...conversationFields(uuid, at),
		type: "user",
		message: { role: "user", content: blocks ?? text },
		...fields,
	};
}

function assistantLine(
	content: object[],
	fields: Record<string, unknown> = {},
) {
	const { uuid, ...rest } = fields;
	return {
		...conversationFields(uuid as string | undefined, undefined),
		type: "assistant",
		message: { role: "assistant", content },
		...rest,
	};
}

function toolUse(id: string, name: string, input: object) {
	return { type: "tool_use", id, name, input };
}

function toolResultLine(
	toolUseId: string,
	result: { is_error?: boolean; content: unknown },
) {
	return userLine({
		blocks: [{ type: "tool_result", tool_use_id: toolUseId, ...result }],
	});
}

function conversationFields(uuid: string | undefined, at: string | undefined) {
	return {
		uuid: uuid ?? crypto.randomUUID(),
		sessionId: SESSION_ID,
		timestamp: at ?? AT,
		cwd: "/work/repo",
		gitBranch: "main",
		entrypoint: "cli",
		isSidechain: false,
	};
}

async function writeSessionFile(
	claude: string,
	name: number,
	fields: { sessionId: string; [field: string]: unknown },
) {
	await Bun.write(
		join(claude, "sessions", `${name}.json`),
		JSON.stringify({
			pid: process.pid,
			cwd: "/nowhere",
			kind: "interactive",
			entrypoint: "cli",
			status: "idle",
			...fields,
		}),
	);
}

function record(
	fields: Partial<SessionRecord> & { id: string },
): SessionRecord {
	return {
		harness: "claude",
		surface: "unknown",
		parentId: null,
		title: null,
		cwd: "/nowhere",
		branch: null,
		startedAt: new Date(AT),
		sourcePath: `/nowhere/${fields.id}.jsonl`,
		...fields,
	};
}

async function createRepository(
	parent: string,
	branch: string,
): Promise<string> {
	const repo = join(parent, "repo");
	mkdirSync(repo);
	await Bun.$`git init --quiet -b ${branch} ${repo}`.quiet();
	return repo;
}

async function exitedPid(): Promise<number> {
	const child = Bun.spawn(["true"]);
	await child.exited;
	return child.pid;
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const AT = "2026-10-23T10:00:00.000Z";

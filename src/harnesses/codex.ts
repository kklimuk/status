import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { basename, join } from "path";
import type {
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	SourceRead,
	ToolStatus,
} from ".";

export function createCodexAdapter(home: string): HarnessAdapter {
	return {
		harness: "codex",
		listSources: (since) => listRollouts(home, since),
		readSource: (path, ingested) => readRollout(home, path, ingested),
		snapshot: async (sessions) => ({
			snapshots: await snapshotThreads(home, sessions),
			warnings: [],
		}),
	};
}

async function listRollouts(home: string, since: Date): Promise<string[]> {
	const root = join(home, "sessions");
	if (!(await isDirectory(root))) {
		return [];
	}
	const paths: string[] = [];
	for await (const relative of new Glob("**/rollout-*.jsonl").scan(root)) {
		const path = join(root, relative);
		const modified = await modifiedAt(path);
		if (modified && modified >= since) {
			paths.push(path);
		}
	}
	return paths.sort();
}

async function readRollout(
	home: string,
	path: string,
	ingested: IngestedSource | null,
): Promise<SourceRead | null> {
	const file = Bun.file(path);
	const firstLine = await readFirstLine(file);
	if (firstLine === null) {
		return null;
	}
	const meta = parseSessionMeta(firstLine, path);
	if (meta.thread_source === "guardian_review") {
		return null;
	}
	const size = file.size;
	const readOffset =
		ingested && ingested.readOffset <= size ? ingested.readOffset : 0;
	const bytes = await file.slice(readOffset).bytes();
	const consumed = bytes.lastIndexOf(NEWLINE) + 1;
	const lines = DECODER.decode(bytes.subarray(0, consumed)).split("\n");

	const parentId = parentThreadId(meta);
	const isSubagent = parentId !== null;
	const historyStart = meta.subagent_history_start_ordinal ?? 0;
	const events: SessionEvent[] = [];
	const warnings: string[] = [];
	let cwd = ingested?.session.cwd ?? meta.cwd;
	let unreadable = 0;
	for (const line of lines) {
		if (line === "") {
			continue;
		}
		const entry = parseLine(line);
		if (entry === null) {
			unreadable += 1;
			continue;
		}
		if ((entry.ordinal ?? historyStart) < historyStart) {
			continue;
		}
		if (entry.type === "turn_context" && entry.payload?.cwd) {
			cwd = entry.payload.cwd;
		}
		if (entry.type === "response_item" && entry.payload) {
			const event = responseItemEvent(entry, entry.payload, isSubagent);
			if (event) {
				events.push(event);
			}
		}
	}
	if (unreadable > 0) {
		warnings.push(`skipped ${unreadable} lines that aren't valid JSON`);
	}

	const thread = readThread(home, meta.id);
	if ("warning" in thread) {
		warnings.push(thread.warning);
	}
	const row = "row" in thread ? thread.row : null;
	const session: SessionRecord = {
		id: `codex:${meta.id}`,
		harness: "codex",
		surface: "unknown",
		parentId: parentId ? `codex:${parentId}` : null,
		title: row?.name || ingested?.session.title || null,
		cwd,
		branch:
			row?.git_branch ?? ingested?.session.branch ?? meta.git?.branch ?? null,
		startedAt: new Date(meta.timestamp),
		sourcePath: path,
	};
	return {
		session,
		events,
		nextOffset: readOffset + consumed,
		warnings,
	};
}

async function snapshotThreads(
	home: string,
	sessions: SessionRecord[],
): Promise<SessionSnapshot[]> {
	const live = await threadsWithHeldLocks(home);
	const snapshots: SessionSnapshot[] = [];
	for (const session of sessions) {
		if (!live.has(session.id.slice("codex:".length))) {
			continue;
		}
		const turn = await readLatestTurn(session.sourcePath);
		const cwd = turn.cwd ?? session.cwd;
		snapshots.push({
			sessionId: session.id,
			state: turn.busy ? "busy" : "idle",
			cwd,
			branch: await liveBranch(cwd, session.branch),
		});
	}
	return snapshots;
}

async function isDirectory(path: string): Promise<boolean> {
	const stat = await Bun.file(path)
		.stat()
		.catch(() => null);
	return stat?.isDirectory() ?? false;
}

async function modifiedAt(path: string): Promise<Date | null> {
	try {
		return (await Bun.file(path).stat()).mtime;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function readFirstLine(file: Bun.BunFile): Promise<string | null> {
	for (let length = FIRST_LINE_CHUNK; ; length *= 4) {
		const bytes = await file.slice(0, length).bytes();
		const newline = bytes.indexOf(NEWLINE);
		if (newline >= 0) {
			return DECODER.decode(bytes.subarray(0, newline));
		}
		if (bytes.length < length) {
			return null;
		}
	}
}

function parseSessionMeta(line: string, path: string): SessionMeta {
	const entry = parseLine(line);
	const meta: Partial<SessionMeta> | undefined =
		entry?.type === "session_meta" ? entry.payload : undefined;
	if (!meta?.id || !meta.timestamp || !meta.cwd) {
		throw new Error(
			`${path} doesn't start with a session_meta line carrying id, timestamp and cwd`,
		);
	}
	return meta as SessionMeta;
}

function parentThreadId(meta: SessionMeta): string | null {
	const source = typeof meta.source === "object" ? meta.source : null;
	return source?.subagent?.thread_spawn?.parent_thread_id ?? null;
}

function parseLine(line: string): RolloutLine | null {
	try {
		const entry = JSON.parse(line);
		return typeof entry === "object" && entry !== null ? entry : null;
	} catch {
		return null;
	}
}

function responseItemEvent(
	entry: RolloutLine,
	payload: Payload,
	isSubagent: boolean,
): SessionEvent | null {
	const at = new Date(entry.timestamp ?? 0);
	const key = payload.call_id ?? payload.id ?? `ordinal:${entry.ordinal}`;
	switch (payload.type) {
		case "message": {
			const text = messageText(payload);
			if (!text || (payload.role !== "user" && payload.role !== "assistant")) {
				return null;
			}
			return { kind: "message", key, at, role: payload.role, text };
		}
		case "agent_message": {
			const text = agentMessageText(payload);
			if (!isSubagent || !text) {
				return null;
			}
			return { kind: "message", key, at, role: "user", text };
		}
		case "function_call":
			return {
				kind: "tool_call",
				key,
				at,
				...describeToolCall(functionTargets(payload)),
			};
		case "custom_tool_call":
			return {
				kind: "tool_call",
				key,
				at,
				...describeToolCall(scriptTargets(payload)),
			};
		case "function_call_output":
		case "custom_tool_call_output":
			return { kind: "tool_result", key, at, toolStatus: toolStatus(payload) };
		default:
			return null;
	}
}

function messageText(payload: Payload): string {
	const parts = (payload.content ?? []).filter(
		(part) =>
			typeof part.text === "string" &&
			(part.type === "input_text" || part.type === "output_text"),
	);
	const texts = parts.map((part) => part.text ?? "");
	const kept = payload.role === "user" ? texts.flatMap(userText) : texts;
	return kept.join("\n").trim();
}

function userText(text: string): string[] {
	if (INJECTED_USER_PART.test(text)) {
		return [];
	}
	const request = text.indexOf(AMBIENT_CONTEXT_REQUEST);
	if (request >= 0) {
		return [text.slice(request + AMBIENT_CONTEXT_REQUEST.length)];
	}
	return [text];
}

function agentMessageText(payload: Payload): string {
	const content = payload.content ?? [];
	const plain = content
		.filter((part) => part.type === "input_text")
		.map((part) => part.text ?? "")
		.join("")
		.trim();
	const encrypted = content.some((part) => part.type === "encrypted_content");
	return encrypted ? `${plain}\n[encrypted payload]`.trim() : plain;
}

function describeToolCall({ toolName, targets }: ToolTargets) {
	const headline = targets[0]?.split("\n")[0]?.slice(0, HEADLINE_LENGTH);
	return {
		text: headline ? `${toolName} ${headline}` : toolName,
		toolName,
		toolTarget: targets.length > 0 ? targets.join("\n") : null,
	};
}

function scriptTargets(payload: Payload): ToolTargets {
	const input = payload.input ?? "";
	const files = matches(input, PATCH_FILE).map((file) => file.trim());
	if (files.length > 0) {
		return { toolName: "apply_patch", targets: [...new Set(files)] };
	}
	const commands = matches(input, SCRIPT_COMMAND).map(jsStringValue);
	if (commands.length > 0) {
		return { toolName: "exec_command", targets: commands };
	}
	const innerTool = input.match(SCRIPT_TOOL)?.[1];
	return {
		toolName: innerTool ?? payload.name ?? "unknown",
		targets: matches(input, SCRIPT_PATH).map(jsStringValue),
	};
}

function functionTargets(payload: Payload): ToolTargets {
	const name = payload.name ?? "unknown";
	const isMcp = payload.namespace?.startsWith("mcp__") ?? false;
	const toolName = isMcp ? `${payload.namespace}__${name}` : name;
	const parsed = parseObject(payload.arguments);
	const target = FUNCTION_TARGET_KEYS.map((key) => parsed[key])
		.map((value) => (Array.isArray(value) ? value.join(" ") : value))
		.find((value): value is string => typeof value === "string" && !!value);
	return { toolName, targets: target ? [target] : [] };
}

function parseObject(text: string | undefined): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text ?? "");
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function matches(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

function jsStringValue(literal: string): string {
	if (literal.startsWith('"')) {
		try {
			return JSON.parse(literal);
		} catch {}
	}
	return literal
		.slice(1, -1)
		.replace(/\\(.)/g, (_sequence, escaped) => JS_ESCAPES[escaped] ?? escaped);
}

function toolStatus(payload: Payload): Exclude<ToolStatus, "pending"> {
	const parts = outputParts(payload.output);
	const first = parts[0] ?? "";
	if (
		first.startsWith("Script completed") ||
		first.startsWith("Script running")
	) {
		return parts.slice(1).some(reportsFailure) ? "error" : "ok";
	}
	const refusal = refusalReason(parts);
	if (refusal.startsWith(GUARDIAN_REJECTION)) {
		return "auto_denied";
	}
	if (USER_REJECTION.test(refusal)) {
		return "user_denied";
	}
	const firstLine = first.split("\n")[0] ?? "";
	if (!/^[[{]/.test(firstLine) && FAILURE_LINE.test(firstLine)) {
		return "error";
	}
	return "ok";
}

function refusalReason(parts: string[]): string {
	const first = parts[0] ?? "";
	if (!first.startsWith("Script failed")) {
		return first.replace(REJECTED_WRAPPER, "");
	}
	const error = parts.at(-1) ?? "";
	const wrapper = SCRIPT_REJECTION.exec(error);
	return wrapper ? error.slice(wrapper[0].length) : "";
}

function outputParts(output: unknown): string[] {
	if (typeof output === "string") {
		return [output];
	}
	if (!Array.isArray(output)) {
		return [];
	}
	return output
		.filter(
			(part) => part?.type === "input_text" && typeof part.text === "string",
		)
		.map((part) => part.text);
}

function reportsFailure(part: string): boolean {
	if (!part.startsWith("{")) {
		return false;
	}
	const result = parseObject(part);
	return (
		(typeof result.exit_code === "number" && result.exit_code !== 0) ||
		result.isError === true
	);
}

function readThread(
	home: string,
	threadId: string,
): { row: ThreadRow | null } | { warning: string } {
	const path = join(home, "state_5.sqlite");
	try {
		return { row: queryThread(path, threadId) };
	} catch {
		// fact: a read-only connection can't read a WAL database whose -shm file is gone, which is how Codex leaves state_5.sqlite when nothing has it open.
		const immutable = `${Bun.pathToFileURL(path).href}?immutable=1`;
		try {
			return { row: queryThread(immutable, threadId) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				warning: `couldn't read the title and branch from ${path}: ${reason}`,
			};
		}
	}
}

function queryThread(filename: string, threadId: string): ThreadRow | null {
	const database = new Database(filename, { readonly: true });
	try {
		return database
			.query<ThreadRow, [string]>(
				"SELECT name, git_branch FROM threads WHERE id = ?",
			)
			.get(threadId);
	} finally {
		database.close();
	}
}

async function threadsWithHeldLocks(home: string): Promise<Set<string>> {
	const directory = join(home, "thread-writer-locks");
	const locks: string[] = [];
	if (await isDirectory(directory)) {
		for await (const name of new Glob("*.lock").scan(directory)) {
			locks.push(join(directory, name));
		}
	}
	if (locks.length === 0) {
		return new Set();
	}
	const child = Bun.spawn(["lsof", "-w", "-F", "n", "--", ...locks], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const held = stdout
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => basename(line.slice(1), ".lock"));
	const problems = stderr
		.split("\n")
		.filter((line) => line.trim() !== "" && !VANISHED_LOCK.test(line));
	// fact: lsof exits 1 when any named file is open by no process, and reports a lock deleted since the scan as a status error; neither is a failure.
	if (exitCode !== 0 && problems.length > 0) {
		throw new Error(
			`lsof couldn't check which Codex threads are live: ${problems.join("\n")}`,
		);
	}
	return new Set(held);
}

async function readLatestTurn(
	path: string,
): Promise<{ busy: boolean; cwd: string | null }> {
	const file = Bun.file(path);
	let busy: boolean | null = null;
	let cwd: string | null = null;
	let end = file.size;
	let carried: Uint8Array = new Uint8Array(0);
	while (end > 0 && (busy === null || cwd === null)) {
		const start = Math.max(0, end - TAIL_CHUNK);
		const bytes: Uint8Array = concatenate(
			await file.slice(start, end).bytes(),
			carried,
		);
		const firstNewline = start === 0 ? -1 : bytes.indexOf(NEWLINE);
		if (firstNewline < 0 && start > 0) {
			carried = bytes;
			end = start;
			continue;
		}
		const lines = DECODER.decode(bytes.subarray(firstNewline + 1)).split("\n");
		for (const line of lines.reverse()) {
			if (busy !== null && cwd !== null) {
				break;
			}
			if (!TURN_LINE.test(line)) {
				continue;
			}
			const entry = parseLine(line);
			const type = entry?.payload?.type;
			if (cwd === null && entry?.type === "turn_context") {
				cwd = entry.payload?.cwd ?? null;
			}
			if (busy === null && entry?.type === "event_msg" && type) {
				if (type === "task_started") {
					busy = true;
				} else if (type === "task_complete" || type === "turn_aborted") {
					busy = false;
				}
			}
		}
		carried = bytes.subarray(0, firstNewline + 1);
		end = start;
	}
	return { busy: busy ?? false, cwd };
}

function concatenate(head: Uint8Array, tail: Uint8Array): Uint8Array {
	const joined = new Uint8Array(head.length + tail.length);
	joined.set(head);
	joined.set(tail, head.length);
	return joined;
}

async function liveBranch(
	cwd: string,
	stored: string | null,
): Promise<string | null> {
	if (cwd === "") {
		return stored;
	}
	try {
		const child = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		return exitCode === 0 ? stdout.trim() || null : stored;
	} catch {
		return stored;
	}
}

type RolloutLine = {
	timestamp?: string;
	ordinal?: number;
	type?: string;
	payload?: Payload;
};

type Payload = {
	type?: string;
	id?: string;
	role?: string;
	call_id?: string;
	name?: string;
	namespace?: string;
	arguments?: string;
	input?: string;
	output?: unknown;
	content?: { type?: string; text?: string }[];
	cwd?: string;
};

type SessionMeta = {
	id: string;
	timestamp: string;
	cwd: string;
	thread_source?: string;
	source?:
		| string
		| { subagent?: { thread_spawn?: { parent_thread_id?: string } } };
	subagent_history_start_ordinal?: number;
	git?: { branch?: string };
};

type ToolTargets = { toolName: string; targets: string[] };

type ThreadRow = { name: string | null; git_branch: string | null };

const NEWLINE = 0x0a;
const DECODER = new TextDecoder();
const FIRST_LINE_CHUNK = 64 * 1024;
const TAIL_CHUNK = 256 * 1024;
const HEADLINE_LENGTH = 200;

const INJECTED_USER_PART =
	/^\s*(<environment_context>|<codex_internal_context\b|<\/?image\b|# AGENTS\.md instructions for )/;
const AMBIENT_CONTEXT_REQUEST = "\n## My request:\n";

const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: (.+?)(?=\\n|\n|$)/gm;
const SCRIPT_COMMAND =
	/\bcmd"?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g;
const SCRIPT_PATH = /\bpath"?\s*:\s*("(?:[^"\\]|\\.)*")/g;
const SCRIPT_TOOL = /\btools\.(\w+)\(/;
const FUNCTION_TARGET_KEYS = [
	"cmd",
	"command",
	"path",
	"task_name",
	"target",
	"query",
];
const JS_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

// fact: strings from the Codex binary.
const USER_REJECTION =
	/^((exec command|patch) rejected by user|user rejected MCP tool call|rejected by user(?! approval settings))/;
const GUARDIAN_REJECTION = "This action was rejected due to unacceptable risk";
const REJECTED_WRAPPER = /^Rejected\("/;
// fact: a refused exec cell's error reads "exec_command failed for `<cmd>`: CreateProcess { message: "Rejected(\"<reason>…", inner quote escaped.
const SCRIPT_REJECTION =
	/^Script error:\n\w+ failed for `[\s\S]*?`: CreateProcess \{ message: "Rejected\(\\?"/;
const FAILURE_LINE = /\bfailed\b|^aborted by user/;
const VANISHED_LOCK = /^lsof: status error on .+: No such file or directory$/;
const TURN_LINE =
	/"type":"(turn_context|task_started|task_complete|turn_aborted)"/;

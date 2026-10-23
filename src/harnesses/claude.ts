import { Glob } from "bun";
import type { Stats } from "fs";
import { lstat, stat } from "fs/promises";
import { join } from "path";
import type {
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	SessionState,
	SourceRead,
} from ".";

export function createClaudeAdapter(home: string): HarnessAdapter {
	return {
		harness: "claude",
		listSources: (since) => listTranscripts(join(home, "projects"), since),
		readSource: readTranscript,
		snapshot: (sessions) => snapshotSessions(join(home, "sessions"), sessions),
	};
}

async function listTranscripts(
	projects: string,
	since: Date,
): Promise<string[]> {
	if (!(await isDirectory(projects))) {
		return [];
	}
	const paths: string[] = [];
	for (const pattern of TRANSCRIPT_PATTERNS) {
		for await (const relative of new Glob(pattern).scan({ cwd: projects })) {
			const path = join(projects, relative);
			const stats = await lstatUnlessGone(path);
			if (stats?.isFile() && stats.mtimeMs >= since.getTime()) {
				paths.push(path);
			}
		}
	}
	return paths;
}

async function lstatUnlessGone(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readTranscript(
	path: string,
	ingested: IngestedSource | null,
): Promise<SourceRead | null> {
	const file = Bun.file(path);
	const head = await readHead(file);
	if (!head || isScripted(head.entrypoint)) {
		return null;
	}
	const size = file.size;
	const start =
		ingested && ingested.readOffset <= size ? ingested.readOffset : 0;
	const bytes = new Uint8Array(await file.slice(start, size).arrayBuffer());
	const end = bytes.lastIndexOf(NEWLINE) + 1;

	const session = await startRecord(path, head, ingested?.session ?? null);
	const events: SessionEvent[] = [];
	let unparseable = 0;
	for (const line of completeLines(bytes.subarray(0, end))) {
		const entry = parseEntry(line);
		if (!entry) {
			unparseable++;
			continue;
		}
		applyEntry(session, entry);
		events.push(...entryEvents(entry));
	}
	const warnings: string[] = [];
	if (unparseable > 0) {
		warnings.push(`skipped ${unparseable} unparseable lines in ${path}`);
	}
	return { session, events, nextOffset: start + end, warnings };
}

function isScripted(entrypoint: unknown): boolean {
	return typeof entrypoint === "string" && entrypoint.startsWith(SDK_PREFIX);
}

async function readHead(file: Bun.BunFile): Promise<Head | null> {
	for (let length = HEAD_CHUNK_BYTES; ; length *= 4) {
		const bytes = new Uint8Array(await file.slice(0, length).arrayBuffer());
		const end = bytes.lastIndexOf(NEWLINE) + 1;
		let startedAt: Date | null = null;
		for (const line of completeLines(bytes.subarray(0, end))) {
			const entry = parseEntry(line);
			startedAt ??= parseTime(entry?.timestamp);
			if (
				startedAt &&
				typeof entry?.uuid === "string" &&
				typeof entry.sessionId === "string"
			) {
				return {
					sessionId: entry.sessionId,
					agentId: typeof entry.agentId === "string" ? entry.agentId : null,
					entrypoint: entry.entrypoint,
					startedAt,
					cwd: typeof entry.cwd === "string" ? entry.cwd : "",
					branch: branchName(entry.gitBranch),
				};
			}
		}
		if (bytes.length < length) {
			return null;
		}
	}
}

async function startRecord(
	path: string,
	head: Head,
	stored: SessionRecord | null,
): Promise<SessionRecord> {
	const isSubagent = head.agentId !== null;
	const base = stored ?? {
		title: null,
		cwd: head.cwd,
		branch: head.branch,
	};
	const meta = isSubagent ? await readSubagentMeta(path) : null;
	const description = meta?.description;
	return {
		id: `claude:${head.agentId ?? head.sessionId}`,
		harness: "claude",
		surface: "unknown",
		parentId: isSubagent ? `claude:${head.sessionId}` : null,
		title: typeof description === "string" ? description : base.title,
		cwd: base.cwd,
		branch: base.branch,
		startedAt: head.startedAt,
		sourcePath: path,
	};
}

async function readSubagentMeta(path: string): Promise<SubagentMeta | null> {
	try {
		return await Bun.file(path.replace(/\.jsonl$/, ".meta.json")).json();
	} catch {
		return null;
	}
}

function completeLines(bytes: Uint8Array): string[] {
	return new TextDecoder()
		.decode(bytes)
		.split("\n")
		.filter((line) => line.trim() !== "");
}

function parseEntry(line: string): TranscriptEntry | null {
	try {
		const entry = JSON.parse(line);
		return typeof entry === "object" && entry !== null ? entry : null;
	} catch {
		return null;
	}
}

function parseTime(value: unknown): Date | null {
	if (typeof value !== "string") {
		return null;
	}
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? null : time;
}

function applyEntry(session: SessionRecord, entry: TranscriptEntry) {
	if (typeof entry.cwd === "string" && entry.cwd !== "") {
		session.cwd = entry.cwd;
	}
	if (typeof entry.gitBranch === "string") {
		session.branch = branchName(entry.gitBranch);
	}
	const title = entry.customTitle ?? entry.agentName ?? entry.aiTitle;
	if (TITLE_TYPES.has(entry.type ?? "") && typeof title === "string") {
		session.title = title;
	}
}

function branchName(gitBranch: unknown): string | null {
	const isNamed =
		typeof gitBranch === "string" &&
		gitBranch !== "" &&
		gitBranch !== DETACHED_HEAD;
	return isNamed ? gitBranch : null;
}

function entryEvents(entry: TranscriptEntry): SessionEvent[] {
	const at = parseTime(entry.timestamp);
	if (!at || typeof entry.uuid !== "string") {
		return [];
	}
	if (entry.type === "assistant") {
		return assistantEvents(entry, entry.uuid, at);
	}
	if (entry.type === "user") {
		return userEvents(entry, entry.uuid, at);
	}
	if (entry.type === "attachment") {
		return queuedPromptEvents(entry, entry.uuid, at);
	}
	return [];
}

function assistantEvents(
	entry: TranscriptEntry,
	key: string,
	at: Date,
): SessionEvent[] {
	if (entry.isApiErrorMessage) {
		return [];
	}
	const events: SessionEvent[] = [];
	const texts: string[] = [];
	for (const block of contentBlocks(entry.message?.content)) {
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
		}
		if (block.type === "tool_use" && typeof block.id === "string") {
			const toolName = typeof block.name === "string" ? block.name : "unknown";
			const toolTarget = toolTargetOf(block.input);
			const headline = toolTarget?.split("\n")[0];
			events.push({
				kind: "tool_call",
				key: block.id,
				at,
				text: headline ? `${toolName} ${headline}` : toolName,
				toolName,
				toolTarget,
			});
		}
	}
	const text = texts.join("\n\n").trim();
	if (text !== "") {
		events.unshift({ kind: "message", key, at, role: "assistant", text });
	}
	return events;
}

function toolTargetOf(input: unknown): string | null {
	if (typeof input !== "object" || input === null) {
		return null;
	}
	for (const key of TARGET_KEYS) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === "string" && value !== "") {
			return value;
		}
	}
	return null;
}

function userEvents(
	entry: TranscriptEntry,
	key: string,
	at: Date,
): SessionEvent[] {
	const content = entry.message?.content;
	const results = contentBlocks(content).filter(
		(block) => block.type === "tool_result",
	);
	if (results.length > 0) {
		const events: SessionEvent[] = [];
		for (const block of results) {
			if (typeof block.tool_use_id === "string") {
				events.push({
					kind: "tool_result",
					key: block.tool_use_id,
					at,
					toolStatus: toolStatusOf(block),
				});
			}
		}
		return events;
	}
	if (!isUserVoice(entry)) {
		return [];
	}
	return userMessage(textPieces(content), key, at);
}

function toolStatusOf(block: ContentBlock): "ok" | "error" | "denied" {
	if (!block.is_error) {
		return "ok";
	}
	const text = textPieces(block.content).join("");
	return text.startsWith(REJECTION_MARKER) ? "denied" : "error";
}

function textPieces(content: unknown): string[] {
	if (typeof content === "string") {
		return [content];
	}
	const pieces: string[] = [];
	for (const block of contentBlocks(content)) {
		if (block.type === "text" && typeof block.text === "string") {
			pieces.push(block.text);
		}
	}
	return pieces;
}

function isUserVoice(entry: TranscriptEntry): boolean {
	if (
		entry.isMeta ||
		entry.isCompactSummary ||
		entry.isVisibleInTranscriptOnly
	) {
		return false;
	}
	return entry.origin === undefined || entry.origin?.kind === "human";
}

function queuedPromptEvents(
	entry: TranscriptEntry,
	key: string,
	at: Date,
): SessionEvent[] {
	const attachment = entry.attachment;
	if (
		attachment?.type !== "queued_command" ||
		attachment.commandMode !== "prompt" ||
		attachment.origin?.kind !== "human"
	) {
		return [];
	}
	return userMessage(textPieces(attachment.prompt), key, at);
}

function userMessage(pieces: string[], key: string, at: Date): SessionEvent[] {
	const text = pieces
		.filter((piece) => !INJECTED_USER_TEXT.test(piece))
		.join("\n\n")
		.trim();
	return text === "" ? [] : [{ kind: "message", key, at, role: "user", text }];
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(
		(block): block is ContentBlock =>
			typeof block === "object" && block !== null,
	);
}

async function snapshotSessions(
	directory: string,
	sessions: SessionRecord[],
): Promise<SessionSnapshot[]> {
	const live = await readLiveSessions(directory);
	const branches = new Map<string, Promise<string | null>>();
	const branchOf = (cwd: string) => {
		const branch = branches.get(cwd) ?? currentBranch(cwd);
		branches.set(cwd, branch);
		return branch;
	};
	const snapshots = await Promise.all(
		sessions.map(async (session): Promise<SessionSnapshot | null> => {
			if (session.parentId === null) {
				const state = live.get(rawId(session.id));
				if (!state) {
					return null;
				}
				return {
					sessionId: session.id,
					state,
					cwd: session.cwd,
					branch: await branchOf(session.cwd),
				};
			}
			if (
				!live.has(rawId(session.parentId)) ||
				!(await isSubagentRunning(session.sourcePath))
			) {
				return null;
			}
			return {
				sessionId: session.id,
				state: "busy",
				cwd: session.cwd,
				branch: await branchOf(session.cwd),
			};
		}),
	);
	return snapshots.filter((snapshot) => snapshot !== null);
}

async function readLiveSessions(
	directory: string,
): Promise<Map<string, LiveState>> {
	const live = new Map<string, LiveState>();
	if (!(await isDirectory(directory))) {
		return live;
	}
	for await (const name of new Glob("*.json").scan({ cwd: directory })) {
		const record = await readSessionFile(join(directory, name));
		if (
			!record ||
			!LIVE_KINDS.has(record.kind) ||
			isScripted(record.entrypoint) ||
			record.parkedJobId !== undefined ||
			!isAlive(record.pid)
		) {
			continue;
		}
		const state = BUSY_STATUSES.has(record.status ?? "") ? "busy" : "idle";
		if (live.get(record.sessionId) !== "busy") {
			live.set(record.sessionId, state);
		}
	}
	return live;
}

async function readSessionFile(path: string): Promise<SessionFile | null> {
	try {
		const record = await Bun.file(path).json();
		const isComplete =
			Number.isInteger(record?.pid) &&
			record.pid > 0 &&
			typeof record.sessionId === "string";
		return isComplete ? record : null;
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function isSubagentRunning(path: string): Promise<boolean> {
	const meta = await readSubagentMeta(path);
	if (meta?.finished) {
		return false;
	}
	try {
		const { mtimeMs } = await stat(path);
		return Date.now() - mtimeMs <= SUBAGENT_QUIET_MS;
	} catch {
		return false;
	}
}

async function currentBranch(cwd: string): Promise<string | null> {
	// fact: `git -C ""` runs in the current directory, which would report the branch `status` runs from.
	if (cwd === "") {
		return null;
	}
	const result = await Bun.$`git -C ${cwd} branch --show-current`
		.nothrow()
		.quiet();
	const branch = result.stdout.toString().trim();
	return result.exitCode === 0 && branch !== "" ? branch : null;
}

function rawId(id: string): string {
	return id.slice("claude:".length);
}

type Head = {
	sessionId: string;
	agentId: string | null;
	entrypoint: unknown;
	startedAt: Date;
	cwd: string;
	branch: string | null;
};

type TranscriptEntry = {
	type?: string;
	uuid?: unknown;
	sessionId?: unknown;
	agentId?: unknown;
	entrypoint?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
	gitBranch?: unknown;
	aiTitle?: unknown;
	agentName?: unknown;
	customTitle?: unknown;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	isVisibleInTranscriptOnly?: boolean;
	isApiErrorMessage?: boolean;
	origin?: { kind?: string };
	message?: { content?: unknown };
	attachment?: {
		type?: string;
		commandMode?: string;
		origin?: { kind?: string };
		prompt?: unknown;
	};
};

type ContentBlock = {
	type?: string;
	text?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	is_error?: boolean;
	content?: unknown;
};

type SubagentMeta = { description?: unknown; finished?: unknown };

type SessionFile = {
	pid: number;
	sessionId: string;
	kind: string;
	entrypoint?: string;
	status?: string;
	parkedJobId?: string;
};

type LiveState = Exclude<SessionState, "ended">;

const TRANSCRIPT_PATTERNS = ["*/*.jsonl", "*/*/subagents/**/agent-*.jsonl"];

const SDK_PREFIX = "sdk-";

const NEWLINE = 0x0a;

const HEAD_CHUNK_BYTES = 64 * 1024;

// fact: Claude writes gitBranch "HEAD" on a detached HEAD, where `git branch --show-current` prints nothing.
const DETACHED_HEAD = "HEAD";

const TITLE_TYPES = new Set(["custom-title", "agent-name", "ai-title"]);

const TARGET_KEYS = ["file_path", "notebook_path", "command", "url", "pattern"];

// fact: Claude Code answers a tool call the user rejected with "The user doesn't want to proceed with this tool use…" or "…take this action right now…".
const REJECTION_MARKER = "The user doesn't want to ";

const INJECTED_USER_TEXT =
	/^\s*(<(command-[a-z]+|local-command-[a-z]+|bash-[a-z]+|ide_[a-z_]+|browser_instruction|system-reminder|task-notification)>|\[Request interrupted by user\]\s*$)/;

const LIVE_KINDS = new Set(["interactive", "bg"]);

const BUSY_STATUSES = new Set(["busy", "shell"]);

const SUBAGENT_QUIET_MS = 2 * 60_000;

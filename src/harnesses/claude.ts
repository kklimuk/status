import { Glob } from "bun";
import type { Stats } from "fs";
import { lstat, stat } from "fs/promises";
import { dirname, join, sep } from "path";
import type {
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	SessionState,
	SnapshotRead,
	SourceRead,
	ToolStatus,
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
	const session = await startRecord(path, head, ingested?.session ?? null);
	if (head.agentId === null) {
		const continuation = await latestContinuation(path);
		if (continuation !== null) {
			return {
				session,
				events: [],
				nextOffset: 0,
				warnings: [],
				continuedIn: `claude:${continuation}`,
			};
		}
	}
	const size = file.size;
	const start =
		ingested && ingested.readOffset <= size ? ingested.readOffset : 0;
	const bytes = new Uint8Array(await file.slice(start, size).arrayBuffer());
	const end = bytes.lastIndexOf(NEWLINE) + 1;

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

function isScripted(entrypoint: unknown): boolean {
	return typeof entrypoint === "string" && entrypoint.startsWith(SDK_PREFIX);
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
	const root = isSubagent ? await subagentRoot(path, head.sessionId) : null;
	return {
		id: `claude:${head.agentId ?? head.sessionId}`,
		harness: "claude",
		surface: "unknown",
		parentId: root === null ? null : `claude:${root}`,
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

async function subagentRoot(path: string, sessionId: string): Promise<string> {
	const marker = `${sep}${sessionId}${sep}subagents${sep}`;
	const index = path.lastIndexOf(marker);
	if (index === -1) {
		return sessionId;
	}
	const rootTranscript = `${path.slice(0, index)}${sep}${sessionId}.jsonl`;
	return (await latestContinuation(rootTranscript)) ?? sessionId;
}

async function latestContinuation(transcript: string): Promise<string | null> {
	let latest: string | null = null;
	let path = transcript;
	const visited = new Set([path]);
	for (;;) {
		const next = await continuedInId(path);
		if (next === null) {
			return latest;
		}
		const nextPath = join(dirname(path), `${next}.jsonl`);
		if (visited.has(nextPath)) {
			return null;
		}
		if (!(await isIngestible(nextPath))) {
			return latest;
		}
		visited.add(nextPath);
		latest = next;
		path = nextPath;
	}
}

async function isIngestible(path: string): Promise<boolean> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return false;
	}
	const head = await readHead(file);
	return head !== null && !isScripted(head.entrypoint);
}

async function continuedInId(path: string): Promise<string | null> {
	const file = Bun.file(path);
	let bytes: Uint8Array;
	try {
		const start = Math.max(0, file.size - CONTINUATION_TAIL_BYTES);
		bytes = new Uint8Array(await file.slice(start).arrayBuffer());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const end = bytes.lastIndexOf(NEWLINE) + 1;
	const candidates = completeLines(bytes.subarray(0, end)).filter((line) =>
		line.includes(CONTINUED_IN_MARKER),
	);
	for (const line of candidates.reverse()) {
		const entry = parseEntry(line);
		if (
			entry?.type === "continued-in" &&
			typeof entry.continuedInSessionId === "string"
		) {
			return entry.continuedInSessionId;
		}
	}
	return null;
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
			const spoken = spokenText(toolName, block.input);
			if (spoken !== null) {
				events.push({
					kind: "message",
					key: `${block.id}:spoken`,
					at,
					role: "assistant",
					text: spoken,
				});
			}
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

function spokenText(toolName: string, input: unknown): string | null {
	if (typeof input !== "object" || input === null) {
		return null;
	}
	const { message, to, questions } = input as Record<string, unknown>;
	if (toolName === "SubagentHandback") {
		return nonEmpty(message);
	}
	if (toolName === "SendMessage") {
		const text = nonEmpty(message);
		return text && typeof to === "string" ? `To ${to}: ${text}` : text;
	}
	if (toolName === "AskUserQuestion" && Array.isArray(questions)) {
		return nonEmpty(questions.map(questionText).join("\n\n"));
	}
	return null;
}

function questionText(question: unknown): string {
	if (typeof question !== "object" || question === null) {
		return "";
	}
	const { question: asked, options } = question as Record<string, unknown>;
	const labels = (Array.isArray(options) ? options : [])
		.map((option) => (option as { label?: unknown } | null)?.label)
		.filter((label): label is string => typeof label === "string");
	return [nonEmpty(asked) ?? "", ...labels.map((label) => `- ${label}`)]
		.join("\n")
		.trim();
}

function nonEmpty(text: unknown): string | null {
	return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
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

function toolStatusOf(block: ContentBlock): Exclude<ToolStatus, "pending"> {
	if (!block.is_error) {
		return "ok";
	}
	const text = textPieces(block.content).join("");
	if (text.startsWith(USER_REJECTION)) {
		return "user_denied";
	}
	if (AUTOMATIC_REFUSALS.some((marker) => text.startsWith(marker))) {
		return "auto_denied";
	}
	return "error";
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
): Promise<SnapshotRead> {
	const { live, warnings } = await readLiveSessions(directory);
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
	return {
		snapshots: snapshots.filter((snapshot) => snapshot !== null),
		warnings,
	};
}

async function readLiveSessions(
	directory: string,
): Promise<{ live: Map<string, LiveState>; warnings: string[] }> {
	const live = new Map<string, LiveState>();
	if (!(await isDirectory(directory))) {
		return { live, warnings: [] };
	}
	const candidates: SessionFile[] = [];
	for await (const name of new Glob("*.json").scan({ cwd: directory })) {
		const record = await readSessionFile(join(directory, name));
		if (
			record &&
			LIVE_KINDS.has(record.kind) &&
			!isScripted(record.entrypoint) &&
			record.parkedJobId === undefined
		) {
			candidates.push(record);
		}
	}
	const processes = await processStarts(candidates.map(({ pid }) => pid));
	for (const record of candidates) {
		if (!isSessionProcess(record, processes)) {
			continue;
		}
		const state = liveState(record.status);
		const stored = live.get(record.sessionId);
		if (!stored || STATE_PRIORITY[state] > STATE_PRIORITY[stored]) {
			live.set(record.sessionId, state);
		}
	}
	if (!("failure" in processes)) {
		return { live, warnings: [] };
	}
	const warning = `couldn't match Claude pids to their start times, so a reused pid can look live: ${processes.failure}`;
	return { live, warnings: [warning] };
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

async function processStarts(pids: number[]): Promise<ProcessStarts> {
	const starts = new Map<number, number | null>();
	if (pids.length === 0) {
		return { starts };
	}
	try {
		const result = await Bun.$`ps -o pid=,lstart= -p ${pids.join(",")}`
			.env({ ...process.env, LC_ALL: "C", TZ: "UTC" })
			.nothrow()
			.quiet();
		const output = result.stdout.toString();
		const errors = result.stderr.toString().trim();
		// fact: ps exits 1 with no output and no error when none of the pids is running.
		const noneRunning =
			result.exitCode === 1 && output.trim() === "" && errors === "";
		if (result.exitCode !== 0 && !noneRunning) {
			return { failure: `ps exited ${result.exitCode}: ${errors}` };
		}
		for (const line of output.split("\n")) {
			const match = PS_LINE.exec(line);
			if (match) {
				starts.set(Number(match[1]), parseProcessStart(match[2]));
			}
		}
		return { starts };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

function isSessionProcess(
	record: SessionFile,
	processes: ProcessStarts,
): boolean {
	if ("failure" in processes) {
		return isAlive(record.pid);
	}
	const started = processes.starts.get(record.pid);
	if (started === undefined) {
		return false;
	}
	const recorded = parseProcessStart(record.procStart);
	return started === null || recorded === null || recorded === started;
}

function parseProcessStart(text: unknown): number | null {
	const match = typeof text === "string" ? CTIME.exec(text.trim()) : null;
	if (!match) {
		return null;
	}
	const [, month, day, hours, minutes, seconds, year] = match;
	const monthIndex = MONTHS.indexOf(month ?? "");
	if (monthIndex === -1) {
		return null;
	}
	return Date.UTC(
		Number(year),
		monthIndex,
		Number(day),
		Number(hours),
		Number(minutes),
		Number(seconds),
	);
}

function liveState(status: string | undefined): LiveState {
	if (status === "waiting") {
		return "waiting";
	}
	return BUSY_STATUSES.has(status ?? "") ? "busy" : "idle";
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
	continuedInSessionId?: unknown;
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
	procStart?: unknown;
};

type ProcessStarts =
	| { starts: Map<number, number | null> }
	| { failure: string };

type LiveState = Exclude<SessionState, "ended">;

const TRANSCRIPT_PATTERNS = ["*/*.jsonl", "*/*/subagents/**/agent-*.jsonl"];

const CONTINUATION_TAIL_BYTES = 64 * 1024;

const CONTINUED_IN_MARKER = '"continued-in"';

const SDK_PREFIX = "sdk-";

const NEWLINE = 0x0a;

const HEAD_CHUNK_BYTES = 64 * 1024;

// fact: Claude writes gitBranch "HEAD" on a detached HEAD, where `git branch --show-current` prints nothing.
const DETACHED_HEAD = "HEAD";

const TITLE_TYPES = new Set(["custom-title", "agent-name", "ai-title"]);

const TARGET_KEYS = ["file_path", "notebook_path", "command", "url", "pattern"];

// fact: Claude Code answers a tool call the user rejected with "The user doesn't want to proceed with this tool use…" or "…take this action right now…".
const USER_REJECTION = "The user doesn't want to ";

// fact: Claude Code's auto-mode classifier and its built-in safety check refuse a call with these prefixes; the safety check adds "…, not by the user."
const AUTOMATIC_REFUSALS = [
	"Permission for this action was denied by the Claude Code auto mode classifier",
	"Permission for this command was denied by a built-in Claude Code safety check",
];

const INJECTED_USER_TEXT =
	/^\s*(<(command-[a-z]+|local-command-[a-z]+|bash-[a-z]+|ide_[a-z_]+|browser_instruction|system-reminder|task-notification)>|\[Request interrupted by user\]\s*$)/;

const LIVE_KINDS = new Set(["interactive", "bg"]);

const BUSY_STATUSES = new Set(["busy", "shell"]);

const STATE_PRIORITY: Record<LiveState, number> = {
	idle: 0,
	busy: 1,
	waiting: 2,
};

const PS_LINE = /^\s*(\d+)\s+(.+?)\s*$/;

// fact: Claude writes procStart, and `ps -o lstart=` under LC_ALL=C prints, a ctime string such as "Fri Oct  3 16:23:39 2026"; procStart is in UTC.
const CTIME =
	/^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

const SUBAGENT_QUIET_MS = 2 * 60_000;

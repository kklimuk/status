import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readlink } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import type {
	HarnessAdapter,
	IngestedSource,
	SessionEvent,
	SessionRecord,
	SessionSnapshot,
	SnapshotRead,
	SourceRead,
	ToolStatus,
} from ".";

export function createCodexAdapter(home: string): HarnessAdapter {
	return {
		harness: "codex",
		listSources: (since) => listRollouts(home, since),
		readSource: (path, ingested) => readRollout(home, path, ingested),
		snapshot: (sessions) => snapshotThreads(home, sessions),
	};
}

export function codexSessionIn(environment: typeof process.env): string | null {
	const threadId = environment.CODEX_THREAD_ID;
	return threadId ? `codex:${threadId}` : null;
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
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
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
	const items: RolloutLine[] = [];
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
			items.push(entry);
		}
	}
	if (unreadable > 0) {
		warnings.push(`skipped ${unreadable} lines that aren't valid JSON`);
	}

	const escalated = await escalatedCalls(file, readOffset, items);
	const events = items.flatMap((entry) => {
		const event = responseItemEvent(entry, isSubagent, escalated);
		return event ? [event] : [];
	});

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

function parseLine(line: string): RolloutLine | null {
	try {
		const entry = JSON.parse(line);
		return typeof entry === "object" && entry !== null ? entry : null;
	} catch {
		return null;
	}
}

function parentThreadId(meta: SessionMeta): string | null {
	const source = typeof meta.source === "object" ? meta.source : null;
	return source?.subagent?.thread_spawn?.parent_thread_id ?? null;
}

async function escalatedCalls(
	file: Bun.BunFile,
	readOffset: number,
	items: RolloutLine[],
): Promise<Set<string>> {
	const escalated = escalatedCallIds(items);
	const calls = new Set(items.filter(isToolCall).map(callIdOf));
	const abortsEarlierCall = items.some(
		(entry) => isUserAbort(entry.payload) && !calls.has(callIdOf(entry)),
	);
	if (!abortsEarlierCall || readOffset === 0) {
		return escalated;
	}
	const earlier = (await file.slice(0, readOffset).text())
		.split("\n")
		.flatMap((line) => parseLine(line) ?? []);
	return new Set([...escalated, ...escalatedCallIds(earlier)]);
}

function escalatedCallIds(entries: RolloutLine[]): Set<string> {
	return new Set(
		entries
			.filter((entry) => isToolCall(entry) && asksEscalation(entry.payload))
			.map(callIdOf),
	);
}

function isToolCall(entry: RolloutLine): boolean {
	const type = entry.payload?.type;
	return (
		entry.type === "response_item" &&
		(type === "custom_tool_call" || type === "function_call")
	);
}

function callIdOf(entry: RolloutLine): string {
	return entry.payload?.call_id ?? "";
}

function asksEscalation(payload: Payload | undefined): boolean {
	const code = (payload?.input ?? payload?.arguments ?? "").replace(
		STRING_LITERAL,
		(literal) => (ESCALATION_WORDS.has(literal.slice(1, -1)) ? literal : '""'),
	);
	return ESCALATION.test(code);
}

function isUserAbort(payload: Payload | undefined): boolean {
	const isOutput =
		payload?.type === "custom_tool_call_output" ||
		payload?.type === "function_call_output";
	return (
		isOutput && (outputParts(payload.output)[0] ?? "").startsWith(USER_ABORT)
	);
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

function responseItemEvent(
	entry: RolloutLine,
	isSubagent: boolean,
	escalated: Set<string>,
): SessionEvent | null {
	const payload = entry.payload ?? {};
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
			return {
				kind: "tool_result",
				key,
				at,
				toolStatus: toolStatus(payload, escalated.has(key)),
			};
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

function toolStatus(
	payload: Payload,
	askedEscalation: boolean,
): Exclude<ToolStatus, "pending"> {
	const parts = outputParts(payload.output);
	const first = parts[0] ?? "";
	if (
		first.startsWith("Script completed") ||
		first.startsWith("Script running")
	) {
		return parts.slice(1).some(reportsFailure) ? "error" : "ok";
	}
	if (first.startsWith(USER_ABORT)) {
		return askedEscalation ? "user_denied" : "error";
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

function refusalReason(parts: string[]): string {
	const first = parts[0] ?? "";
	if (!first.startsWith("Script failed")) {
		return first.replace(REJECTED_WRAPPER, "");
	}
	const error = parts.at(-1) ?? "";
	const wrapper = SCRIPT_REJECTION.exec(error);
	return wrapper ? error.slice(wrapper[0].length) : "";
}

function readThread(
	home: string,
	threadId: string,
): { row: ThreadRow | null } | { warning: string } {
	const path = join(home, "state_5.sqlite");
	try {
		return {
			row: queryState(path, (database) =>
				threadNameAndBranch(database, threadId),
			),
		};
	} catch (error) {
		return {
			warning: `couldn't read the title and branch from ${path}: ${errorMessage(error)}`,
		};
	}
}

function queryState<Result>(
	path: string,
	select: (database: Database) => Result,
): Result {
	try {
		return withDatabase(path, select);
	} catch {
		// fact: a read-only connection can't read a WAL database whose -shm file is gone, which is how Codex leaves state_5.sqlite when nothing has it open.
		return withDatabase(`${Bun.pathToFileURL(path).href}?immutable=1`, select);
	}
}

function withDatabase<Result>(
	filename: string,
	select: (database: Database) => Result,
): Result {
	const database = new Database(filename, { readonly: true });
	try {
		return select(database);
	} finally {
		database.close();
	}
}

function threadNameAndBranch(
	database: Database,
	threadId: string,
): ThreadRow | null {
	return database
		.query<ThreadRow, [string]>(
			"SELECT name, git_branch FROM threads WHERE id = ?",
		)
		.get(threadId);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function snapshotThreads(
	home: string,
	sessions: SessionRecord[],
): Promise<SnapshotRead> {
	if (sessions.length === 0) {
		return { snapshots: [], warnings: [] };
	}
	const warnings: string[] = [];
	const daemon = await askDaemon(home, new Set(sessions.map(threadIdOf))).catch(
		(error): DaemonAnswer => {
			warnings.push(daemonWarning(error));
			return { socket: null, statuses: new Map() };
		},
	);
	const heldOutsideDaemon = await threadsHeldOutsideDaemon(home, daemon.socket);

	const live = sessions.filter(
		(session) =>
			daemon.statuses.has(threadIdOf(session)) ||
			heldOutsideDaemon.has(threadIdOf(session)),
	);
	const snapshots = await Promise.all(
		live.map(async (session): Promise<SessionSnapshot> => {
			const status = daemon.statuses.get(threadIdOf(session));
			const turn = await readLatestTurn(session.sourcePath);
			const cwd = turn.cwd ?? session.cwd;
			return {
				sessionId: session.id,
				state: status ? daemonState(status) : rolloutState(turn),
				cwd,
				branch: await liveBranch(cwd, session.branch),
			};
		}),
	);
	return { snapshots, warnings };
}

function threadIdOf(session: SessionRecord): string {
	return session.id.slice("codex:".length);
}

async function askDaemon(
	home: string,
	threadIds: Set<string>,
): Promise<DaemonAnswer> {
	const socket = await daemonSocket(home);
	if (!socket) {
		return { socket: null, statuses: new Map() };
	}
	return { socket, statuses: await daemonStatuses(socket, threadIds) };
}

async function daemonSocket(home: string): Promise<string | null> {
	try {
		// fact: lsof names a Unix socket by the path the daemon bound, which is the target Codex gives the control link.
		const socket = await linkTarget(join(home, DAEMON_SOCKET));
		if (!(await Bun.file(socket).stat()).isSocket()) {
			throw new Error(`${socket} isn't a socket`);
		}
		return socket;
	} catch (error) {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
}

async function linkTarget(path: string): Promise<string> {
	try {
		return resolve(dirname(path), await readlink(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EINVAL") {
			return path;
		}
		throw error;
	}
}

function daemonWarning(error: unknown): string {
	return `couldn't ask the Codex app-server daemon which threads are live, so every held writer lock counts as live: ${errorMessage(error)}`;
}

async function daemonStatuses(
	socket: string,
	threadIds: Set<string>,
): Promise<Map<string, ThreadStatus>> {
	const daemon = await connectDaemon(socket);
	try {
		resultOf(
			"initialize",
			await daemon.request("initialize", {
				clientInfo: { name: "status", version: "0.0.1" },
				capabilities: { experimentalApi: true },
			}),
		);
		daemon.notify("initialized");
		const loaded = (await loadedThreadIds(daemon)).filter((threadId) =>
			threadIds.has(threadId),
		);
		const threads = await Promise.all(
			loaded.map((threadId) => loadedThread(daemon, threadId)),
		);
		const statuses = new Map<string, ThreadStatus>();
		for (const thread of threads) {
			if (
				thread &&
				thread.status.type !== "notLoaded" &&
				LIVE_THREAD_SOURCES.has(thread.threadSource ?? "user")
			) {
				statuses.set(thread.id, thread.status);
			}
		}
		return statuses;
	} finally {
		daemon.close();
	}
}

function connectDaemon(socket: string): Promise<DaemonConnection> {
	const opened = Promise.withResolvers<DaemonConnection>();
	const pending = new Map<number, PromiseWithResolvers<DaemonReply>>();
	const webSocket = new WebSocket(`ws+unix://${socket}`);
	const timer = setTimeout(
		() => fail(`no answer within ${DAEMON_TIMEOUT / 1000}s`),
		DAEMON_TIMEOUT,
	);
	let failure: Error | null = null;
	let nextId = 1;

	function fail(reason: string) {
		failure ??= new Error(reason);
		clearTimeout(timer);
		opened.reject(failure);
		for (const waiter of pending.values()) {
			waiter.reject(failure);
		}
		pending.clear();
		webSocket.close();
	}

	function send(message: object) {
		webSocket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
	}

	webSocket.onerror = () => fail(`couldn't connect to ${socket}`);
	webSocket.onclose = () => fail("the daemon closed the connection");
	webSocket.onmessage = (event) => {
		const message: DaemonReply = parseObject(String(event.data));
		if (typeof message.method === "string") {
			return;
		}
		if (typeof message.id !== "number") {
			fail(`the daemon sent a message that isn't JSON-RPC: ${event.data}`);
			return;
		}
		pending.get(message.id)?.resolve(message);
		pending.delete(message.id);
	};
	webSocket.onopen = () =>
		opened.resolve({
			request(method, params) {
				if (failure) {
					return Promise.reject(failure);
				}
				const id = nextId++;
				const waiter = Promise.withResolvers<DaemonReply>();
				pending.set(id, waiter);
				send({ id, method, params });
				return waiter.promise;
			},
			notify(method) {
				send({ method });
			},
			close() {
				clearTimeout(timer);
				webSocket.onclose = null;
				webSocket.close();
			},
		});
	return opened.promise;
}

async function loadedThreadIds(daemon: DaemonConnection): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	do {
		const result = resultOf(
			"thread/loaded/list",
			await daemon.request("thread/loaded/list", { cursor }),
		) as { data?: unknown; nextCursor?: unknown };
		const page = result.data;
		if (
			!Array.isArray(page) ||
			!page.every((threadId) => typeof threadId === "string")
		) {
			throw new Error("thread/loaded/list returned no list of thread ids");
		}
		ids.push(...page);
		cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
	} while (cursor);
	return ids;
}

async function loadedThread(
	daemon: DaemonConnection,
	threadId: string,
): Promise<DaemonThread | null> {
	const reply = await daemon.request("thread/read", {
		threadId,
		includeTurns: false,
	});
	if (reply.error?.message?.startsWith("thread not loaded")) {
		return null;
	}
	const result = resultOf("thread/read", reply) as {
		thread?: Partial<DaemonThread>;
	};
	const thread = result.thread;
	if (thread?.id !== threadId || !isThreadStatus(thread.status)) {
		throw new Error(
			`thread/read returned no recognizable status for ${threadId}`,
		);
	}
	return thread as DaemonThread;
}

function resultOf(method: string, reply: DaemonReply): unknown {
	if (reply.error) {
		throw new Error(`${method} failed: ${reply.error.message ?? "no reason"}`);
	}
	if (typeof reply.result !== "object" || reply.result === null) {
		throw new Error(`${method} returned no result`);
	}
	return reply.result;
}

function isThreadStatus(status: unknown): status is ThreadStatus {
	const candidate = status as Partial<{ type: unknown; activeFlags: unknown }>;
	if (candidate?.type === "active") {
		return Array.isArray(candidate.activeFlags);
	}
	return (
		candidate?.type === "idle" ||
		candidate?.type === "notLoaded" ||
		candidate?.type === "systemError"
	);
}

async function threadsHeldOutsideDaemon(
	home: string,
	socket: string | null,
): Promise<Set<string>> {
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
	const files = socket ? [...locks, socket] : locks;
	const child = Bun.spawn(["lsof", "-w", "-F", "pn", "--", ...files], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const problems = stderr
		.split("\n")
		.filter((line) => line.trim() !== "" && !VANISHED_LOCK.test(line));
	// fact: lsof exits 1 when any named file is open by no process, and reports a lock deleted since the scan as a status error; neither is a failure.
	if (exitCode !== 0 && problems.length > 0) {
		throw new Error(
			`lsof couldn't check which Codex threads are live: ${problems.join("\n")}`,
		);
	}
	const holders = holdersByFile(stdout);
	const daemonPids = new Set(socket ? holders.get(socket) : []);
	const held = new Set<string>();
	for (const [file, pids] of holders) {
		if (file.endsWith(".lock") && pids.some((pid) => !daemonPids.has(pid))) {
			held.add(basename(file, ".lock"));
		}
	}
	return held;
}

function holdersByFile(lsofOutput: string): Map<string, string[]> {
	const holders = new Map<string, string[]>();
	let pid = "";
	for (const line of lsofOutput.split("\n")) {
		if (line.startsWith("p")) {
			pid = line.slice(1);
		}
		if (line.startsWith("n")) {
			const file = line.slice(1);
			holders.set(file, [...(holders.get(file) ?? []), pid]);
		}
	}
	return holders;
}

async function readLatestTurn(path: string): Promise<LatestTurn> {
	const file = Bun.file(path);
	let open: boolean | null = null;
	let context: { cwd: string; reviewer: string | null } | null = null;
	let lastCall: { id: string; escalated: boolean } | null = null;
	const answered = new Set<string>();
	let end = file.size;
	let carried: Uint8Array = new Uint8Array(0);
	while (end > 0 && (open === null || context === null)) {
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
			if (open !== null && context !== null) {
				break;
			}
			const wantsToolLine = lastCall === null && TOOL_LINE.test(line);
			if (!wantsToolLine && !TURN_LINE.test(line)) {
				continue;
			}
			const entry = parseLine(line);
			const payload = entry?.payload;
			if (!entry || !payload) {
				continue;
			}
			if (context === null && entry.type === "turn_context" && payload.cwd) {
				context = {
					cwd: payload.cwd,
					reviewer: payload.approvals_reviewer ?? null,
				};
			}
			if (open !== null) {
				continue;
			}
			if (entry.type === "event_msg" && payload.type === "task_started") {
				open = true;
			} else if (
				entry.type === "event_msg" &&
				(payload.type === "task_complete" || payload.type === "turn_aborted")
			) {
				open = false;
			} else if (isToolCall(entry)) {
				lastCall ??= {
					id: callIdOf(entry),
					escalated: asksEscalation(payload),
				};
			} else if (payload.type?.endsWith("_output")) {
				answered.add(callIdOf(entry));
			}
		}
		carried = bytes.subarray(0, firstNewline + 1);
		end = start;
	}
	return {
		open: open ?? false,
		cwd: context?.cwd ?? null,
		awaitingApproval:
			context?.reviewer === "user" &&
			lastCall !== null &&
			lastCall.escalated &&
			!answered.has(lastCall.id),
	};
}

function concatenate(head: Uint8Array, tail: Uint8Array): Uint8Array {
	const joined = new Uint8Array(head.length + tail.length);
	joined.set(head);
	joined.set(tail, head.length);
	return joined;
}

function daemonState(status: ThreadStatus): SessionSnapshot["state"] {
	if (status.type !== "active") {
		return "idle";
	}
	const waiting = status.activeFlags.some((flag) => WAITING_FLAGS.has(flag));
	return waiting ? "waiting" : "busy";
}

function rolloutState(turn: LatestTurn): SessionSnapshot["state"] {
	if (!turn.open) {
		return "idle";
	}
	return turn.awaitingApproval ? "waiting" : "busy";
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
	approvals_reviewer?: string;
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

type DaemonAnswer = {
	socket: string | null;
	statuses: Map<string, ThreadStatus>;
};

type DaemonConnection = {
	request(method: string, params: object): Promise<DaemonReply>;
	notify(method: string): void;
	close(): void;
};

type DaemonReply = {
	id?: unknown;
	method?: unknown;
	result?: unknown;
	error?: { message?: string };
};

type DaemonThread = {
	id: string;
	status: ThreadStatus;
	threadSource?: string | null;
};

type ThreadStatus =
	| { type: "notLoaded" | "idle" | "systemError" }
	| { type: "active"; activeFlags: string[] };

type LatestTurn = {
	open: boolean;
	cwd: string | null;
	awaitingApproval: boolean;
};

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
const ESCALATION = /\bsandbox_permissions"?\s*:\s*["'`]require_escalated["'`]/;
const ESCALATION_WORDS = new Set(["sandbox_permissions", "require_escalated"]);
const STRING_LITERAL =
	/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

// fact: strings from the Codex binary.
const USER_REJECTION =
	/^((exec command|patch) rejected by user|user rejected MCP tool call|rejected by user(?! approval settings))/;
const GUARDIAN_REJECTION = "This action was rejected due to unacceptable risk";
const USER_ABORT = "aborted by user";
const REJECTED_WRAPPER = /^Rejected\("/;
// fact: a refused exec cell's error reads "exec_command failed for `<cmd>`: CreateProcess { message: "Rejected(\"<reason>…", inner quote escaped.
const SCRIPT_REJECTION =
	/^Script error:\n\w+ failed for `[\s\S]*?`: CreateProcess \{ message: "Rejected\(\\?"/;
const FAILURE_LINE = /\bfailed\b/;

const DAEMON_SOCKET = join("app-server-control", "app-server-control.sock");
const DAEMON_TIMEOUT = 5000;
const LIVE_THREAD_SOURCES = new Set(["user", "subagent"]);
const WAITING_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const VANISHED_LOCK = /^lsof: status error on .+: No such file or directory$/;
const TURN_LINE =
	/"type":"(turn_context|task_started|task_complete|turn_aborted)"/;
const TOOL_LINE =
	/"type":"(custom_tool_call|function_call|custom_tool_call_output|function_call_output)"/;

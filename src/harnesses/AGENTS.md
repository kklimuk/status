# Harnesses

`index.ts` owns the session contract. `claude.ts` and `codex.ts` each implement `HarnessAdapter` for one harness, and `src/app.ts` registers them with that harness's home (`createClaudeAdapter(paths.claude)`). An adapter only reads its harness's files. Sync stores what the adapters return.

## Ids

- **Session ids carry their harness:** `claude:<sessionId>`, `claude:<agentId>` for a Claude subagent, and `codex:<threadId>`. `parentId` uses the same form. The adapter builds both.
- **Each source holds exactly one session, and no two sources share an id.** On this machine, no Claude session or agent id appears in two files.

## `listSources(since)`

- Returns every transcript modified at or after `since`, subagents' transcripts included.

## `readSource(path, ingested)`

- **`ingested` is what sync stored after the last read:** the record and `readOffset`, or `null` for a source it has never stored. Read from `readOffset`, or from 0 when it's `null`.
- **Only complete lines are consumed.** `nextOffset` points just past the last newline, so a half-written line is read on the next run.
- **The record describes the session as of `nextOffset`.** Start from `ingested.session` and change only what the new lines change. Claude writes `ai-title` lines, and the current `cwd` and `gitBranch`, all through a transcript, so the head of the file can't supply the latest title, directory or branch. Re-read the head for what never changes: the id, the parent and the start time.
- **Return `null` when there's nothing to ingest:** a skipped source (Claude `entrypoint: sdk-cli`, Codex `thread_source: guardian_review`), or one without a complete first line yet. Sync stores nothing for it, so it's checked again on the next run.
- **A file shorter than `readOffset` was rewritten.** Read it again from 0; stable keys make that safe.
- **`warnings` names anything the read had to do without,** such as titles when Codex's `state_5.sqlite` can't be read. The read carries on, and sync reports the warning instead of staying silent.
- **`continuedIn` names the session that replaces this one,** when the harness moved its work into a new session that starts with a copy of this one's history. Sync then drops this session and moves its subagents under the continuation, and ignores `events` and `nextOffset`. An adapter whose harness never does this leaves it unset.

## Events

- **`key` is unique within its session and stable across re-reads.** Derive it from the transcript: an entry's uuid, a tool call's id, or a line's byte offset. Never derive it from read order.
- **`message`** is user or assistant text, in full.
- **`tool_call`** is stored as `pending`. Its `text` is a headline (the tool name and its target), and `toolTarget` is the file path, command, URL or pattern the call acted on. A call that edits several files (Codex `apply_patch`) lists them in `toolTarget`, one per line.
- **`tool_result`** reuses its call's `key` and carries only the outcome: `ok`, `error`, `user_denied` when a person rejected the call, or `auto_denied` when an automatic reviewer refused it. `user_denied` means don't ask the user to approve it again; `auto_denied` means the agent may need the user's manual approval or another approach. It can arrive in a later read than its call. Sync updates the stored call's `tool_status` in place and never resets a finished call to `pending`.

## `snapshot(sessions)`

- **Returns the live sessions among those it's given, subagents included,** each `busy`, `idle` or `waiting` with its live `cwd` and `branch`. `waiting` means blocked on the user: a permission prompt or a question the harness itself is holding open. Sync marks every session the snapshot leaves out `ended`.
- **`warnings` names anything the snapshot had to do without,** such as a liveness check that couldn't run. The snapshot still returns its best answer, and sync reports the warnings.
- **Snapshots observe the real present** (live pids, file modification times), so adapters use the real clock, not `app.now()`.

## Surface

- **`surface` is `unknown` in v1.** The markers for later: Claude writes `entrypoint` on every line (`cli`, `claude-vscode`, `sdk-cli`), and Codex writes `source` (`cli`, `vscode`) and `originator` in `session_meta`.

## Claude

Checked against `~/.claude` on 2026-10-23 (Claude Code 2.1.309): 28 root transcripts and 1,215 subagent transcripts, matching `find`.

### Sources

- **Root transcripts are `projects/*/<sessionId>.jsonl`; subagents are `projects/*/<sessionId>/subagents/**/agent-<agentId>.jsonl`.** The `**` covers workflow agents under `subagents/workflows/wf_*/`. The `journal.jsonl` and `*.meta.json` files beside them aren't transcripts.
- **Symlinked transcripts are skipped.** When an interactive session is moved into a background job, the job's `subagents/` links to the original session's subagent files, so the same agent shows up under two paths. Its real file, under the original session, is the source. A transcript deleted between the scan and its `lstat` (Claude's cleanup of old transcripts) is skipped, not a failed listing.
- **The skip and the head come from the first line with a `uuid`.** Root files open with `mode`, `permission-mode`, `ai-title` or `queue-operation` lines, which have no `uuid` and no `entrypoint`. `startedAt` is the first `timestamp` in the file. A file without a complete `uuid` line yet returns `null`.
- **Every `sdk-*` entrypoint is skipped,** for a root and its subagents alike. `claude -p` writes `sdk-cli` (205 transcripts here); the Agent SDK writes `sdk-ts` or `sdk-py`, which are scripted too, though none appear on this machine. Old transcripts (2.1.31) have no `entrypoint` at all and are ingested.

### Record

- **`title` is the latest `custom-title`, `agent-name` or `ai-title` line,** whichever came last. A subagent has none of these; its title is `description` from its `agent-<id>.meta.json`.
- **`branch` is the latest `gitBranch`;** `HEAD` (a detached checkout) is stored as `null`, as `git branch --show-current` reports it.
- **A subagent's `parentId` is the root session,** even for a nested agent (`spawnDepth: 2`). Its meta's `parentAgentId` names the agent that spawned it, and isn't used yet.
- **A subagent's parent follows continuations,** below: an agent under `<old>/subagents/` belongs to the session that replaced `<old>`.

### Continued sessions

- **When an interactive session moves into a background job, the job replaces it.** Claude Code creates a new session for the job, copies every entry of the old transcript into it (same `uuid`s, the new `sessionId`), appends `{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}` to the old transcript, and symlinks some of the old session's subagent files into the job's `subagents/` (only the one still running, in the one real case: 1 of 2).
- **A root read checks the last 64 KiB of its transcript for a `continued-in` line,** whatever `readOffset` says, so a session stored before the line was appended is caught too. It follows the chain (a job continued again) through sibling `<id>.jsonl` files and returns the last one as `continuedIn`, without parsing events.
- **A continuation counts only once its transcript can be ingested:** it exists, has a complete `uuid` line, and isn't `sdk-*`. Nothing is dropped before what replaces it is stored.
- **The marker counts anywhere in the last 64 KiB,** even with entries after it. In the one real case it's the last line. If a parked session were written to again, its new lines would be dropped while the marker stays in the tail. Unverified, because none has been.
- **A chain that loops back to a transcript already on it replaces nothing,** so two sessions that name each other are both kept rather than both dropped.
- **A subagent's `parentId` resolves through the same chain** from its root transcript, `projects/*/<sessionId>.jsonl`, so a re-read never moves it back under the dropped session.
- **Out-of-window limit:** the old transcript is only re-read while `listSources` lists it. Appending `continued-in` bumps its modification time, so this only misses when `status` doesn't run for the whole window after the continuation.
- **`claude --resume <id> --fork-session` is not deduped.** A fork copies every entry with its `uuid`, re-stamped with the new `sessionId` (12 of 12 in a probe), and writes no marker in either file. Both halves go on independently, so the copied prefix shows up in both sessions.

### Events

- **Each assistant line holds one content block.** `text` becomes a `message` keyed by the line's `uuid`; `tool_use` becomes a `tool_call` keyed by its `id`; `thinking` is skipped, and so are synthetic `isApiErrorMessage` lines ("API Error: …").
- **A `tool_result` block is `error` when `is_error` is set, with two exceptions decided by how its text starts:**
  - `user_denied`: `The user doesn't want to `. Claude writes "…proceed with this tool use" for a rejected call and "…take this action right now" for one interrupted at the prompt.
  - `auto_denied`: `Permission for this action was denied by the Claude Code auto mode classifier` (followed by "Reason: …") or `Permission for this command was denied by a built-in Claude Code safety check` (followed by "not by the user", for removals that could delete far more than intended). Both appear in real transcripts.
  - The text must start with the marker, so a failed command whose output quotes one stays `error`.
- **The tool target is the first of `file_path`, `notebook_path`, `command`, `url` and `pattern`;** the headline is the tool name and the target's first line.
- **Three tools carry the agent's own words, so each call also becomes an assistant `message`,** keyed `<tool_use id>:spoken`, right after its `tool_call`:
  - `SubagentHandback`: `message` is a subagent's final report to its parent. Many subagents report only this way, with no assistant text at all.
  - `SendMessage`: `message` to `to` (a subagent, `main` or a peer session), stored as `To <to>: <message>`.
  - `AskUserQuestion`: each of `questions` as its `question` followed by its options' `label`s, one `- <label>` per line. The answer arrives as a tool result and isn't kept.
  - Empty text adds no message. Every other tool's input is instructions to a tool, not speech: `StructuredOutput` is a scripted agent's typed result, and `Agent`'s `prompt` is already the subagent's first user message.
- **A user line is the user's words only when** it has no `isMeta`, `isCompactSummary` or `isVisibleInTranscriptOnly`, and its `origin` is absent or `kind: human`. That skips skill bodies, system reminders, compaction summaries, peer and coordinator messages, and task notifications.
- **Within those, text that starts with an injected tag is skipped:** `<command-*>` (slash-command wrappers), `<local-command-*>`, `<bash-*>` (`!` shell input and output), `<ide_*>`, `<browser_instruction>`, `<system-reminder>`, `<task-notification>`, and a bare `[Request interrupted by user]`. Two are kept on purpose:
  - `<pasted_content>`, because it's what the user pasted;
  - `[Request interrupted by user for tool use]`, which follows a rejected call's `user_denied` result. A result only updates its call's row in place, and summaries find new events by id, so this line is how they see the denial.
- **A message typed while Claude is busy appears only as an `attachment` line** of type `queued_command`, with `commandMode: prompt` and `origin.kind: human`. Its `prompt` is a string or content blocks, and its text becomes a user `message` keyed by the attachment's `uuid`.
- **A subagent's first user message is its task,** written by its parent. Workflow agents get two: `[Workflow harness — user request]` and `[Workflow harness — computed task]`.
- **Every other line type is skipped:** `attachment` (apart from queued prompts), `system`, `api-request*`, `file-history-*`, `last-prompt`, `queue-operation`, `mode`, `permission-mode`, `atis-latch`, `cost-state`, `pr-link` and `continued-in`.

### Snapshot

- **`sessions/<pid>.json` counts when its pid is this session's process, its `kind` is `interactive` or `bg`, its `entrypoint` isn't `sdk-*`, and it has no `parkedJobId`.** `claude -p` writes `kind: interactive` too, so `kind` alone doesn't tell a scripted run apart. `daemon` and `daemon-worker` are Claude's own processes. `parkedJobId` marks an interactive session moved into a background job: its process stays open, but the work goes on in the job's session.
- **`sessions/` is read once per snapshot,** one `ps` runs for every candidate pid, and `git` runs only for live sessions, once per directory.
- **A pid is the session's only when its process started when the pid file says.** A stale file can name a pid the OS has given to an unrelated process. `procStart` is a ctime string in UTC ("Fri Oct 23 16:23:39 2026"), and `ps -o pid=,lstart= -p <pids>` prints the same format, so it runs with `LC_ALL=C` and `TZ=UTC` and the two must agree to the second. Claude Code checks its own holders the same way.
  - A pid `ps` doesn't list is dead. `ps` exits 1 with no output when none of the pids is running, which isn't a failure.
  - A file without a parseable `procStart` counts when `ps` lists its pid, and so does a listed pid whose `lstart` doesn't parse.
  - **When `ps` itself fails,** each pid falls back to `kill(pid, 0)` (alive, or `EPERM`) and the snapshot warns that a reused pid can look live, rather than marking every session ended.
- **`status` maps `busy` and `shell` to `busy`, `waiting` to `waiting`, and `idle` to `idle`.** These four are every value Claude Code 2.1.310 writes. It writes `waiting` while anything holds the session for the user, and names it in `waitingFor`: a permission prompt or other dialog (`dialog open`), a question or elicitation (`input needed`), `sandbox request`, `worker request` or `goal proposal`. When two live pid files name one session, `waiting` beats `busy`, which beats `idle`. A torn or unreadable file, or one without a positive integer `pid`, is skipped: `kill(0, 0)` signals the caller's own process group and would always look alive.
- **A live session's `cwd` is its transcript's latest `cwd`, and its branch comes from `git -C <cwd> branch --show-current`.** The pid file's `cwd` is where the session started and never moves; one transcript here passes through 31 directories as the session moves between worktrees.
- **A subagent is `busy` while its parent's pid file is live (in any state), its meta isn't `finished: true`, and its transcript changed in the last 2 minutes.** A background subagent keeps working while its parent sits idle, so a busy parent isn't required. A subagent quiet for over 2 minutes (a long test run, say) shows as ended until it writes again.
  - **A subagent never shows `waiting`.** Its permission prompts surface in the parent's UI, so the parent's pid file says `waiting`, and the subagent stays `busy` for its 2 minutes. Nothing in the pid file says whose prompt it is. Real subagent rejections came 0 to 16 seconds after the call, so the cutoff rarely bites.

## Codex

Checked against 306 rollouts from Codex CLI 0.150 to 0.164, on 2026-10-23.
- **Sources:** `<codex>/sessions/**/rollout-*.jsonl`. The first line is `session_meta`; a file whose first line isn't one with `id`, `timestamp` and `cwd` fails its read. A rollout that disappears between the scan and its `stat` (archiving moves it out of `sessions/`) isn't listed.
- **Every line carries an `ordinal`,** its index in the file. Keys are the payload's `call_id` for tool calls and results, and its `id` (`msg_…`, `amsg_…`) for messages, so a result always matches a call stored by an earlier read.
- **Skipped sources:** `thread_source: guardian_review` (about a third of all rollouts).
- **Subagents** (`thread_source: subagent`, `source.subagent.thread_spawn.parent_thread_id`) start with a copy of the parent's history: a second `session_meta` and the parent's messages. Lines with `ordinal` below `session_meta.subagent_history_start_ordinal` are that copy and are skipped.
- **Title and branch** come from `state_5.sqlite`'s `threads`, opened read-only: `name` is the generated title (`title` there is only the first prompt, injected text included), `git_branch` the branch. Subagents have no `name`. Without the database, the read keeps the stored values, falls back to `session_meta.git.branch`, and warns.
  - **The database is in WAL mode, and Codex removes its `-wal` and `-shm` files when nothing has it open.** A read-only connection can't open it then ("unable to open database file"), so the read retries with `immutable=1`: with no `-wal` file, the main file holds every committed row.
- **`cwd`** is the latest `turn_context.cwd`, starting from `session_meta.cwd`.

### What becomes an event

- `response_item` `message` with role `user` or `assistant`, `function_call`, `custom_tool_call`, and their `_output` items. Every other `response_item` (`reasoning`, `additional_tools`) and every other line type (`event_msg`, `turn_context`, `world_state`, `compacted`, `token_usage_record`, `inter_agent_communication_metadata`, `session_meta`) is skipped.
- **Injected content kept out of `message` events.** Codex writes all of this as messages; none of it is what anyone said:
  - every `developer` message (permissions, skills, multi-agent role, collaboration mode);
  - user content parts that start with `<environment_context>`, `<codex_internal_context` (goal continuation), `# AGENTS.md instructions for`, or the `<image …>` / `</image>` wrappers around an attached image;
  - the ambient-UI prefix (`<in-app-browser-context>`, `# Chrome tabs:`) before `\n## My request:\n`; only what follows is kept.
  - `<send_user_message_question_reply>` is kept: it's the user's answers to a question.
- **`agent_message`** is how agents talk. In a subagent it's the task or a follow-up from its parent, stored as a `user` message. The payload is encrypted, so only the plaintext header survives (`Message Type: NEW_TASK`, `Task name: /root/<name>`), followed by `[encrypted payload]`. In a root session it's a subagent's report, already in the subagent's own rollout, so it's skipped.
- **Tools:** almost every call is `custom_tool_call` `exec`, a JavaScript cell that calls `tools.<name>(…)`. The adapter names the call after what it does: `apply_patch` with the `*** Add|Update|Delete File:` paths, else `exec_command` with each `cmd`, else the first `tools.<name>` with any `path`. A `function_call` keeps its `name` (`mcp__<server>__<name>` for MCP) and takes its target from `cmd`, `command`, `path`, `task_name`, `target` or `query`.

### Tool outcomes

- Outputs are a string or a list of `input_text` parts. An `exec` output's first part is `Script completed`, `Script running with cell ID …` (still running in the background), or `Script failed`.
- **`ok`:** `Script completed` or `Script running`, unless a later JSON part has a non-zero `exit_code` or `isError: true`, which makes it `error`.
- **Refusals are read from a reason at a fixed place, never searched for in output.** For `Script failed`, the last part reads ``Script error:\nexec_command failed for `<cmd>`: CreateProcess { message: "Rejected(\"<reason>…``, and the reason is what follows `Rejected(\"`. It's the second part when the cell printed nothing first; the error comes after any output the cell produced before the refused call. For any other not-completed output, the reason is its first part, minus a leading `Rejected("`. Marker text inside a command or its output is never a refusal.
- **`user_denied`:** the reason starts with `exec command rejected by user`, `patch rejected by user`, `user rejected MCP tool call` or `rejected by user` (strings from the Codex binary). No user rejection appears on this machine, so how one is wrapped inside an exec cell is unverified; the `CreateProcess` shape is assumed from the guardian's.
- **`auto_denied`:** the reason starts with the guardian's `This action was rejected due to unacceptable risk`. All 6 real ones are `exec_command` cells in the `CreateProcess` shape.
- **Sandbox and approval-policy refusals stay `error` (or `ok`).** "Network access was denied by the Codex sandbox network proxy" and "rejected by user approval settings" are in the binary, but neither appears as a tool output on this machine.
- **`error`:** `Script failed`, `aborted by user after …` (the user interrupted it), or a non-JSON first line containing `failed`.

### Liveness

- **A live thread holds `<codex>/thread-writer-locks/<threadId>.lock` open.** `codex exec` deletes it on exit. `snapshot` lists the lock files and runs one `lsof -w` over them; a lock file nobody holds is stale. lsof exits 1 whenever one lock is unheld, so only stderr marks a failure: `-w` keeps its warnings about unrelated mounts off stderr, and a lock deleted between the scan and `lsof` (a `status error … No such file or directory`) is a thread that just ended.
- **The TUI, VS Code and the desktop app run threads inside the shared `codex app-server` daemon,** which holds the lock and the rollout, not the client. The daemon keeps a thread loaded after its TUI exits (still held 12 minutes later), so a closed TUI session can show as `idle` until the daemon unloads it.
- **Busy or idle** comes from the rollout's last turn marker, read backwards from the end: `event_msg` `task_started` is busy; `task_complete` or `turn_aborted` is idle.
- **Live branch** is `git branch --show-current` in the live `cwd`; a detached `HEAD` is `null`. When git can't answer (no repository, empty `cwd`), the stored branch stands.

### Self-identification

- Commands Codex runs get `CODEX_THREAD_ID=<threadId>` (and `CODEX_SESSION_ID`, the same value for a root thread) in their environment, so `status summaries` can leave out `codex:$CODEX_THREAD_ID`.

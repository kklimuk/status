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

## Events

- **`key` is unique within its session and stable across re-reads.** Derive it from the transcript: an entry's uuid, a tool call's id, or a line's byte offset. Never derive it from read order.
- **`message`** is user or assistant text, in full.
- **`tool_call`** is stored as `pending`. Its `text` is a headline (the tool name and its target), and `toolTarget` is the file path, command, URL or pattern the call acted on. A call that edits several files (Codex `apply_patch`) lists them in `toolTarget`, one per line.
- **`tool_result`** reuses its call's `key` and carries only the outcome: `ok`, `error`, or `denied` when the user rejected the call. It can arrive in a later read than its call. Sync updates the stored call's `tool_status` in place and never resets a finished call to `pending`.

## `snapshot(sessions)`

- **Returns the live sessions among those it's given, subagents included,** each `busy` or `idle` with its live `cwd` and `branch`. Sync marks every session the snapshot leaves out `ended`.
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
- **A background job continued from an interactive session is a separate root session.** The old transcript ends with a `continued-in` line naming the job, and the job's transcript starts with a copy of the old one's history.

### Events

- **Each assistant line holds one content block.** `text` becomes a `message` keyed by the line's `uuid`; `tool_use` becomes a `tool_call` keyed by its `id`; `thinking` is skipped, and so are synthetic `isApiErrorMessage` lines ("API Error: …").
- **A `tool_result` block is `error` when `is_error` is set, and `denied` when its text starts with `The user doesn't want to `.** Claude writes "…proceed with this tool use" for a rejected call and "…take this action right now" for one interrupted at the prompt. Denials by the auto-mode classifier or the safety check ("Permission for this … was denied by …") are `error`: no user rejected them.
- **The tool target is the first of `file_path`, `notebook_path`, `command`, `url` and `pattern`;** the headline is the tool name and the target's first line.
- **A user line is the user's words only when** it has no `isMeta`, `isCompactSummary` or `isVisibleInTranscriptOnly`, and its `origin` is absent or `kind: human`. That skips skill bodies, system reminders, compaction summaries, peer and coordinator messages, and task notifications.
- **Within those, text that starts with an injected tag is skipped:** `<command-*>` (slash-command wrappers), `<local-command-*>`, `<bash-*>` (`!` shell input and output), `<ide_*>`, `<browser_instruction>`, `<system-reminder>`, `<task-notification>`, and a bare `[Request interrupted by user]`. Two are kept on purpose:
  - `<pasted_content>`, because it's what the user pasted;
  - `[Request interrupted by user for tool use]`, which follows a rejected call's `denied` result. A result only updates its call's row in place, and summaries find new events by id, so this line is how they see the denial.
- **A message typed while Claude is busy appears only as an `attachment` line** of type `queued_command`, with `commandMode: prompt` and `origin.kind: human`. Its `prompt` is a string or content blocks, and its text becomes a user `message` keyed by the attachment's `uuid`.
- **A subagent's first user message is its task,** written by its parent. Workflow agents get two: `[Workflow harness — user request]` and `[Workflow harness — computed task]`.
- **Every other line type is skipped:** `attachment` (apart from queued prompts), `system`, `api-request*`, `file-history-*`, `last-prompt`, `queue-operation`, `mode`, `permission-mode`, `atis-latch`, `cost-state`, `pr-link` and `continued-in`.

### Snapshot

- **`sessions/<pid>.json` counts when its pid is alive, its `kind` is `interactive` or `bg`, its `entrypoint` isn't `sdk-*`, and it has no `parkedJobId`.** `claude -p` writes `kind: interactive` too, so `kind` alone doesn't tell a scripted run apart. `daemon` and `daemon-worker` are Claude's own processes. `parkedJobId` marks an interactive session moved into a background job: its process stays open, but the work goes on in the job's session.
- **`sessions/` is read once per snapshot,** and `git` runs only for live sessions, once per directory.
- **`status` maps `busy` and `shell` to `busy`, and `idle` and `waiting` to `idle`.** Claude's UI shows `busy` and `shell` as working and `waiting` (a permission prompt or dialog) as blocked. A torn or unreadable file, or one without a positive integer `pid`, is skipped: `kill(0, 0)` signals the caller's own process group and would always look alive.
- **A live session's `cwd` is its transcript's latest `cwd`, and its branch comes from `git -C <cwd> branch --show-current`.** The pid file's `cwd` is where the session started and never moves; one transcript here passes through 31 directories as the session moves between worktrees.
- **A subagent is `busy` while its parent's pid file is live (busy or idle), its meta isn't `finished: true`, and its transcript changed in the last 2 minutes.** A background subagent keeps working while its parent sits idle, so a busy parent isn't required. A subagent quiet for over 2 minutes (a long test run, say) shows as ended until it writes again.

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
- **`denied`:** `exec command rejected by user`, `patch rejected by user`, `user rejected MCP tool call` (strings from the Codex binary; no user rejection appears on this machine), or the guardian's `Rejected("This action was rejected due to unacceptable risk.…")`. Only the first 2,000 characters of a not-completed output are checked.
- **`error`:** `Script failed`, `aborted by user after …` (the user interrupted it), or a non-JSON first line containing `failed`.

### Liveness

- **A live thread holds `<codex>/thread-writer-locks/<threadId>.lock` open.** `codex exec` deletes it on exit. `snapshot` lists the lock files and runs one `lsof -w` over them; a lock file nobody holds is stale. lsof exits 1 whenever one lock is unheld, so only stderr marks a failure: `-w` keeps its warnings about unrelated mounts off stderr, and a lock deleted between the scan and `lsof` (a `status error … No such file or directory`) is a thread that just ended.
- **The TUI, VS Code and the desktop app run threads inside the shared `codex app-server` daemon,** which holds the lock and the rollout, not the client. The daemon keeps a thread loaded after its TUI exits (still held 12 minutes later), so a closed TUI session can show as `idle` until the daemon unloads it.
- **Busy or idle** comes from the rollout's last turn marker, read backwards from the end: `event_msg` `task_started` is busy; `task_complete` or `turn_aborted` is idle.
- **Live branch** is `git branch --show-current` in the live `cwd`; a detached `HEAD` is `null`. When git can't answer (no repository, empty `cwd`), the stored branch stands.

### Self-identification

- Commands Codex runs get `CODEX_THREAD_ID=<threadId>` (and `CODEX_SESSION_ID`, the same value for a root thread) in their environment, so `status summaries` can leave out `codex:$CODEX_THREAD_ID`.

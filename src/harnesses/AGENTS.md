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

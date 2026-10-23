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

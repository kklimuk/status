# Summaries

`refreshSummaries(app)` keeps one rolling Haiku summary per root session in `summaries`, so an agent or the user can act on a session without opening its transcript. It reads `sessions` and `events`, which sync writes, and owns every read and write of `summaries`.

## The report

`refreshSummaries` returns a `SummaryReport` and never throws for one session's failure:
- `refreshed`: sessions whose summary now covers their newest event, including those advanced without a call (see Coverage).
- `deferred`: busy sessions whose summary is under 15 minutes old and was kept as is. They're ids, so a command can mark those summaries as behind.
- `calls` and `inputTokens`: Haiku calls made and the input tokens they billed, retries included.
- `warnings`: calls whose largest prompt crossed the 100,000-token price tier, with the estimate the chunk was cut by, so the estimate can be tuned.
- `failures`: each `SummaryIssue` names the session and the error. **A non-empty `failures` means the run is half-finished,** and the commands exit non-zero on it, as with sync's. The failed session keeps its old summary, whose `through_event_id` and `updated_at` still say how far it reaches, so it never passes for fresh.

## Staleness

- **A root session is stale when the newest event id across it and its subagents is past `through_event_id`.** Event ids are global ingest order, so one number covers the whole family. A subagent's events are its own session's rows, so a root with no new events of its own still goes stale when a subagent works.
- **A root is a session without a `parent_id`.** Subagents are found at any depth through `parent_id` (Claude's are one level; a Codex subagent can spawn its own). A subagent whose parent isn't stored is never summarized on its own.
- **A busy root keeps a summary younger than 15 minutes.** `status summaries` runs often, and a busy session changes on every run. Only the root's own state counts: an idle root with busy subagents may be waiting on the user, which is exactly when a fresh summary matters. A root without a summary is summarized whatever its state.
- **A tool result that only changes a status isn't seen.** It updates its call's row in place and keeps the id, so `pending` → `user_denied` or `ok` moves no id past `through_event_id`. That's accepted:
  - A status change is almost never the last thing a session writes. A Claude rejection is followed by a `[Request interrupted by user for tool use]` user message, which the adapter keeps for this reason; an approval runs the tool and the assistant answers; a Codex model replies to a declined command. Each is a new id.
  - Seeing it wouldn't be enough. The rolling input holds only events past `through_event_id`, so the changed row wouldn't be in it, and the call would restate the old summary.
  - What's left is a session that dies right after a tool result: its summary can call that tool pending, next to a live state of `ended`.
  - If the real-data pass shows misses: sync's `last_event_at` includes tool-result times, so `last_event_at > updated_at` across the family flags the change, and the next call would then have to re-send the covered calls of the last turn.

## Coverage

- **Planning reads in one transaction,** through the transaction's handle. `through_event_id` is the family's newest id from the same snapshot as the entries, so an event ingested by another run meanwhile is either covered and in the input, or neither.
- **A refresh is stored only after its last chunk succeeds.** Entries are cut into chunks in time order, but ids are ingest order (a subagent's file can be ingested after its parent's), so a chunk boundary isn't an id boundary that a partial summary could claim. A failure in any chunk keeps the old summary.
- **A stored summary is never replaced by one that covers fewer events.** The upsert only overwrites when the new `through_event_id` is at least the stored one, because two runs at once (agents run `status summaries` in parallel) can finish out of order.
- **New events that add no entries advance the summary without a call.** A running subagent's tool calls don't change its task or latest message, so only `through_event_id` moves. `updated_at` stays when Haiku last wrote the summary, so an advance doesn't restart the 15-minute busy deferral.
- **At most 4 sessions are summarized at once,** each one's chunks in sequence, with `summarizing 3/12` through `app.progress` as each starts. Sessions go in order of their root's latest event, newest first.

## Input

- **A header names the session's title and working directory.** The prompt doesn't ask for paths relative to it, because sync keeps the latest `cwd`, which moves when a session changes worktree, and items written earlier would silently change base.
- **Entries in time order, each with its UTC minute:**
  - user and assistant messages in full, with a message over 16,000 characters cut in the middle, keeping 8,000 from each end;
  - tool calls as one line: the tool name and target (several targets joined with commas), or the headline when there's no target, cut at 300 characters, with the status as stored (`ok`, `error`, `user_denied`, `auto_denied`, `pending`). Tool output isn't stored;
  - each subagent's task where it started, and its latest assistant message where it was written. Nothing else from a subagent goes in, and subagents get no call of their own:
    - **The task is the last prompt before the subagent's first reply,** looked for among its first 8 events. A plain subagent has one. A Claude workflow agent has two, `[Workflow harness — user request]` (the user's request, the same for every agent) and then `[Workflow harness — computed task]`, its own.
    - **A Codex subagent's task is encrypted.** The adapter keeps its plaintext header (`Message Type`, `Task name: /root/<name>`, `Sender`) and ends it with `Payload:` and `[encrypted payload]`. The input drops the marker and says the task is encrypted apart from its header, so Haiku works from the name and the report.
    - **The latest message is `finished` when it's the subagent's newest event,** and `unfinished, latest message` when a tool call or a new prompt came after it. This reads the transcript rather than the live state, which the Claude adapter sets to `ended` after two quiet minutes, even mid-tool.
- **A later chunk or refresh also gets the summary so far and the first user message verbatim** (cut like any message), so the objective can't drift.
- **Live state stays out.** A summary changes only when events arrive, so it has to stay true while the state goes from busy to idle to ended. The readers show the live state next to it.

## Chunks and tokens

- **The 100,000-token price tier applies per request,** to the whole prompt: the CLI's own preamble, the system prompt, the schema, the summary so far, the first user message and the entries. Crossing it makes the whole prompt cost 5x.
- **Entries are cut at about 85,000 estimated tokens per chunk, at 2 UTF-8 bytes per token.** That leaves about 15,000 for the rest (a capped first message is at most about 7,000).
- **Bytes, not characters,** because a character outside ASCII takes 2 to 4 bytes and is often a token or more on its own. Counted in characters, a CJK chunk of 170,000 characters would send well over 100,000 tokens. For ASCII the two counts are the same.
- **Why 2 and not 4:** measured on 2026-10-23, a real Claude transcript ran 2.2 to 2.3 characters per token (paths, hashes and shell commands), and the synthetic prose fixtures about 3.2. At 4, a real 341,000-character chunk estimated at 85,000 tokens sent a 150,451-token prompt. At 2, the same transcript's chunks were 75,000 to 80,000 tokens.
- **Warnings compare `largestPromptTokens`, not `inputTokens`** (root `AGENTS.md`, "Calling Claude"). A call the CLI retried bills about twice its prompt.

## Storage

- **`progress`, `tried`, `next` and `blockers` hold one item per line,** and an empty column means no items. Haiku returns them as arrays; whitespace inside an item is collapsed, so an item never spans lines.
- **An `ask` comes exactly with `waiting_on: user`, and a `done` session waits on no one.** The schema states both rules with `if`/`then`, so the CLI's schema check sends a contradiction back to Haiku within the call; on 2026-10-23 a provoked `done` with `waiting_on: user` came back as `in_progress`. A blank `ask` is null.
- **Haiku's answer is checked against the schema in code** before it's stored, both rules included. A missing field, an unknown `waiting_on` or `outcome`, or a contradiction fails that session, like a failed call. An `ask` with another `waiting_on` used to be dropped silently, which under the done rule below would hide an offer.

## The prompt

The prompt is the feature: a summary is only useful if an agent can act on it without the transcript. What it settles, and why:
- **Two readers, named in the prompt.** Agents need exact paths, commands, hashes and errors, and what already failed. The user's triage needs what finished, what's running and what's waiting on them.
- **Field boundaries are spelled out, because Haiku blurs them otherwise:**
  - `tried` holds failed or dropped approaches with why: errors, rejected attempts, denied calls, a subagent's search that came up empty. It doesn't hold open problems (`blockers`), problems since solved (`progress`, with the fix) or trivia like a typo fixed on the next try.
  - `blockers` holds only what stops progress now. A dead end the session routed around is a `tried` item.
  - `next` holds only steps the session stated or committed to. Haiku used to add a review or a wider test run of its own, and a rolling update then carried it forward ("as the prior plan stated"), which kept a finished session `in_progress`. An offer still waiting on the user's answer is the `ask`, not a `next` step.
- **If there's still work to be done, it's not done.** `done` means nothing is left: the latest report says the work is finished and proposes nothing further. A session that ends offering or proposing more work ("Want me to push and open a PR?") is `in_progress` and `waiting_on: user`, and the `ask` is the offer as a yes-or-no question. The user decided this on 2026-10-23, reversing the first version, which called such a session `done` and put the offer in `next` as "Offered: …". Checked on real sessions, the old rule also wobbled: one session flipped between `done` and `in_progress` across runs, and another came back `done` while `waiting_on: user`.
- **The `ask` is self-contained:** what is being decided, the options with the session's recommendation, and the context needed to answer.
- **Rolling updates carry `progress` and `tried` forward.** Without that rule, a four-chunk session's final `tried` kept only the last chunk's trivia (a `/tmp/null` typo, an ECONNRESET) and lost the dead ends from the first three.
- **A denied call means two different things, and the prompt keeps them apart.** The status is rendered as stored:
  - `user_denied`: a person rejected the call, so the user has already said no. It goes in `tried` with the user's reason when the transcript gives one, and the `ask` never asks to approve it again.
  - `auto_denied`: an automatic reviewer refused it (Claude's auto-mode classifier, Codex's guardian) and no human decided. It's a blocker when the session stalled on it, since the agent may need the user's manual approval or another approach, and a `tried` item when the session worked around it.
- **Enum values are written bare in the prompt.** That alone didn't stop Haiku returning `"\"user\""`: the cause was how the CLI's tool call encodes top-level fields, and `askClaude` now nests the schema (root `AGENTS.md`, "Calling Claude").

The prompt was checked against real Haiku on hard-case fixtures: a session ending on a question (then answered), a recap after a commit, subagents hitting dead ends, a denied and abandoned publish, and a real four-chunk transcript. The done rule was re-checked on a recap after a commit that offers to push and open a PR, a finished session that offers nothing, and four real sessions. The fixtures and probes were scratch files in each stream's worktree, so they aren't kept. To repeat the check, rebuild those cases as rows in a temporary `STATUS_HOME` and run `refreshSummaries` on it.

# Statuses

`@src/statuses` turns the stored sessions and summaries into what the `status` commands show: the daily brief by goal (`writeBrief`), and an answer to one question (`answerQuestion`), both judged by Opus (`claude-opus-5-5`, medium effort). It chooses the roots in the window, builds Opus's input, holds the prompts and schemas, calls `app.askClaude`, and checks the answer. It returns plain data, never text to print: the CLI lays it out, colors it and logs the call (`src/cli/AGENTS.md`, `status list` and `status get`).
- **`brief.ts` is the listing** (`writeBrief`, its prompt, schema and checks), **`question.ts` is the question** (`answerQuestion`, likewise), and **`utils.ts` holds what both use:** `rootsInWindow`, the Opus input, the shared prompt guides (`INPUT_GUIDE`, `NEXT_MOVE_GUIDE`, `LIVE_STATE_GUIDE`), the model and the answer checks. `index.ts` re-exports all three.

## Roots in the window

- **`rootsInWindow(database, since)` returns the root sessions whose family was active since `since`,** newest family first. A family is a root and its subagents at any depth, through `parent_id`; a root is in the window when it or any subagent has `last_event_at` within it. Subagents are folded into their root: they're never their own entries.
- **Each root carries:** its session row, its summary, its subagents, the `state` and objective of each one that isn't `ended`, the family's latest activity, and whether its summary is behind.
- **A summary is behind** when the root has none, or when the newest event id across its family is past its `through_event_id`. That's summaries' own staleness rule, read through `summariesBySession` and `newestEventIdBySession` from `@src/summaries`, and the same one `status summaries list` uses. It covers deferred and failed summaries alike.

## Opus's input

Per root, in a `## <id>` block:
- its live state, title, directory and branch;
- its last activity (time and age);
- its subagent count, with each subagent that isn't `ended` and its state and objective;
- the summary without `tried`, which doesn't bear on goals or what to do next, marked when it's behind.

`get` sends the same input with `Question: <question>` last. The summaries' `objective`, `progress` and `blockers` are written for this brief (`src/summaries/AGENTS.md`, "The prompt").

## The brief

The user asked for it on 2026-10-24: the session-first triage before it (ids, states, directories and ages first, one line per session, pasted asks) was impossible to read. The brief is organized by goal, and says for each goal what it is overall, what was done, what's in the way and what the user should do next.
- **Per goal, Opus returns:**
  - `name`;
  - `status`: `needs_you`, `running` or `finished`;
  - `goal`: what it is overall and why, and what done looks like, in 1–2 sentences, synthesized across its sessions;
  - `done`: milestones with evidence, at most 4; a finished goal's is exactly one item, what it delivered;
  - `blockers`: at most 3 high-level obstacles, not questions;
  - `next`: for a needs-you goal, the user's actions in order, rewritten from the asks with each session's recommendation; for a running goal, what the agents are doing now; empty for a finished one;
  - `sessions`: the goal's ids.
- **Every list item is one line of at most about 110 characters, with no marker or session id,** because the CLI numbers and footnotes them. Code strips a leading `-`, `*`, `•`, `1.` or `1)` anyway: the first real run came back numbered twice (`1. 1.`).
- **The goals come back in Opus's order.** The prompt asks for needs-you goals in the order the user should take them, so the CLI numbers them that way.
- **Opus picks the status, and code never overrides it,** not even for `waiting` or `busy`. The user decided this on 2026-10-23 after reading the first version's rule table, which derived it in code from the live state and the summary: they want Opus's judgment, which can weigh an old, unanswered ask on an ended session or a summary that lags the session.
  - The prompt defines the statuses by who has the next move: needs you, the developer's; running, an agent or something external is making progress; finished, nothing is left for anyone. A goal takes the most urgent of its sessions'.
  - It says what each live state means: `waiting` is a prompt or question open now, `busy` is a turn in progress, `idle` is a turn that ended with the session still open, `ended` is a process that's gone. A subagent's state counts toward its root, and an `idle` one (Codex) waits on its root, not the developer.
  - `get`'s prompt shares these definitions (`NEXT_MOVE_GUIDE`, `LIVE_STATE_GUIDE`), so "blocked on me" means the same in both.
- **The answer is checked against the input.** The schema lists the input's ids and the three statuses as enums and requires at least one session per goal, so the CLI's schema check sends a bad value back to Opus within the call; the code check is the backstop.
  - An id it wasn't given, an id listed twice, a status outside the three, or a missing field rejects the whole answer. The brief then has no goals, every root is `ungrouped`, and `failure` says why. A failed call fails the same way.
  - A root Opus left out comes back in `ungrouped` with `failure` null, since every other goal is still sound.

## The answer to a question

- **Opus returns `{ answer, sessions }`:** the answer as plain text, and the ids it rests on, most relevant first. The schema lists the input's ids as an enum, and the code check is the backstop: an id it wasn't given sets `failure`. A repeated id is kept once.

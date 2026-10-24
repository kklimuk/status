# CLI

- **The first argument names the command.** `run(args, openApp)` sends `status summaries …` to `commands/summaries.ts` with the remaining arguments. It sends a bare `status`, or one whose first argument is an option, to `commands/status.ts` with all of them. Anything else is an unknown command. So `status --days 3 summaries` fails closed on a stray argument.
- **Each command parses its own options with `util.parseArgs` in strict mode.** An unknown command or option, a stray argument or a bad value fails closed: exit code 1, the reason on stderr, then the usage. Both commands read `--days <n>` (default 7) through `parseDays`, so they accept the same values.
- **`status --help` lists every command, and `status summaries --help` shows its own usage.** Each command exports its synopsis (`STATUS_USAGE`, `SUMMARIES_USAGE`), `usage(…)` formats synopses, and `src/cli/index.ts` lists them all.
- **`--days` runs from 1 to 3650.** A bigger value would put `since` past the range of a `Date`, and sync would compare against an invalid one.
- **Both commands bring the store up to date with `refresh(app, days)` before they read it:** `sync` over the window, then `refreshSummaries`. It never throws over an adapter or a summary. It returns:
  - `deferred`: busy roots whose family kept its summaries this run, so a command can mark them as behind;
  - `failed`: true when sync or a summary failed. The run is then half-finished, and the command prints what it has and exits 1;
  - `issues`: one line per failure (`failed: claude read <path>: …`, `failed: summary <id>: …`), then one per warning, ready to print after the command's own output. Empty when there are none.
- **A command opens the app only after its options parse,** by calling `openApp()`. So `--help` and a mistyped option never create `~/.status`. Tests pass an `openApp` that throws to check this.
- **An error a command throws fails closed** as `status: <message>` with exit code 1, without the usage.
- **Commands return `{ output, exitCode }` and never write.** `src/index.ts` writes the output: to stdout on success, to stderr on failure.
- **Color goes through `colorize(text, tone)`.** A tone is a semantic name mapped to a color in one `TONES` table: `heading` and `error`, plus `running`, `blocked`, `finished` and `muted` for session states and buckets. Commands never write escape codes themselves.
- **Piped output is always plain.** `Bun.color(…, "ansi")` emits escape codes even when the output isn't a terminal, so `src/index.ts` strips them with `Bun.stripANSI` unless the stream it writes to is a TTY. Agents read piped output, so this matters more than the color does.
- **`NO_COLOR` already works.** `Bun.color` returns an empty string when it's set, and `colorize` then returns the text unchanged.

## `status`

The human's morning triage: root sessions active in the `--days` window, grouped by goal, each in a bucket (blocked on you, running, finished) with one line. Subagents are folded into their root.
- **The bucket is derived in code, not by Opus.** Opus groups sessions into goals and writes the lines; it gets each bucket as a fixed input. The live state is the strongest signal there is, and a second judge could contradict it (a `busy` session called finished, a `waiting` one called running) or contradict the summary that `status summaries` shows for the same session. Derived, the bucket is deterministic and testable. In order:
  - `waiting`, or any subagent at any depth `waiting`, is blocked: a prompt or question is open. A Codex subagent holds its own approval prompt while its parent stays `busy` waiting on it, so the parent's state alone would call it running.
  - `busy`, or any subagent at any depth `busy`, is running.
  - No summary: `idle` is blocked, `ended` is finished.
  - Summary `done` or `abandoned` is finished.
  - `idle` and `in_progress` waiting on `external` is running.
  - Any other `in_progress` is blocked. An `idle` one's turn ended and the next move is the user's; an `ended` one stopped with work left, and only the user can resume or drop it.
- **The window is family activity:** a root is in it when it or any subagent has `last_event_at` within `--days`.
- **A summary is behind** when the root has none, or when the newest event id across its family is past its `through_event_id`, the same rule `status summaries` uses. That covers deferred and failed summaries alike. Opus is told, and the session shows `summary behind`.
- **Opus's answer is checked against the input.** The schema lists the input's ids as an enum, so the CLI's schema check sends an invented id back to Opus within the call; the code check is the backstop. An id it wasn't given, or one listed twice, rejects the whole answer: every session is shown under `Not grouped` with its objective, followed by `failed: grouping by goal: …`, and the run exits 1. A session it left out is shown under `Not grouped` with a warning, and the run still exits 0, since every session is on screen. A failed call fails the same way as a rejected answer.
- **The ask is printed verbatim** under a blocked session's line, from its summary. A `waiting` session, or one with a `waiting` subagent, without one says where a prompt or question is open.
- **Goals are ordered by their most urgent bucket, then by latest activity;** sessions within a bucket by latest activity. Opus's order isn't used.
- **No session in the window prints one line and makes no Opus call.**
- **Opus input:** per root, its bucket and the reason for it, live state, title, directory, branch, last activity, subagent counts with each busy subagent's objective, and the summary without `tried`, which doesn't bear on goals or one line.

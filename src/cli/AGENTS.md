# CLI

- **Commands are nouns and verbs.** The nouns are `status` and `status summaries`; each has the verbs `list` and `get`. `run(args, openApp)` sends `status summaries <verb> …` to the `summaries` noun and everything else to the `status` noun, which reads its first argument as the verb. `src/cli/index.ts` owns that table: per noun, its verbs and the help entries its help lists (the `status` noun's help lists all four commands).
- **A bare noun prints its help, the same as `--help`, and exits 0,** without opening the app. An unknown verb fails closed with that noun's usage, so `status --days 3` (an option where the verb goes) is `unknown command "--days"`.
- **A noun's verbs share one file named after the noun,** because they share most of their code: `commands/status.ts` holds `statusList` and `statusGet`, `commands/summaries.ts` holds `summariesList` and `summariesGet`.
- **Each verb parses its own arguments with `util.parseArgs` in strict mode.** An unknown option, a stray or missing argument or a bad value fails closed: exit code 1, the reason on stderr, then that verb's usage. `get` takes exactly one positional (the quoted question, or the session id). The verbs with a window read `--days <n>` (default 7) through `parseDays`, so they accept the same values.
- **Each verb exports its `CommandHelp`:** a name, a synopsis, a one-line `about`, `details` and its options. `help(…)` formats one verb's help (synopsis, about and details, options) or a noun's (every synopsis, then each verb's `about`), and `usage(…)` formats synopses alone, for errors.
- **`--days` runs from 1 to 3650.** A bigger value would put `since` past the range of a `Date`, and sync would compare against an invalid one.
- **Every verb brings the store up to date with `refresh(app, days, scopeAfterSync)` before it reads it:** `sync` over the window, then `refreshSummaries(app, scopeAfterSync())`. The scope is computed after the sync so `summaries get` can resolve its id against sessions that just appeared. It never throws over an adapter or a summary. It returns:
  - `deferred`: busy roots whose family kept its summaries this run, so a command can mark them as behind;
  - `haiku`: the summary calls made and the input tokens they billed, for the run's totals;
  - `failed`: true when sync or a summary failed. The run is then half-finished, and the command prints what it has and exits 1;
  - `issues`: one line per failure (`failed: claude read <path>: …`, `failed: summary <id>: …`), then one per warning, ready to print after the command's own output. Empty when there are none.
- **A command opens the app only after its options parse,** by calling `openApp()`. So `--help` and a mistyped option never create `~/.status`. Tests pass an `openApp` that throws to check this.
- **An error a command throws fails closed** as `status: <message>` with exit code 1, without the usage.
- **Commands return `{ output, exitCode }` and never write.** `src/index.ts` writes the output: to stdout on success, to stderr on failure.
- **Color goes through `colorize(text, tone)` from `@src/utils`.** A tone is a semantic name mapped to a color in one `TONES` table: `heading` and `error`, plus `running`, `blocked`, `finished` and `muted` for session states and buckets, and `STATE_TONES` maps each session state to one. It lives in `src/utils.ts`, not here, because sync's and summaries' progress lines color states and results too, and they can't import `src/cli`. Commands never write escape codes themselves.
- **Piped output is always plain.** `Bun.color(…, "ansi")` emits escape codes even when the output isn't a terminal, so `src/index.ts` strips them with `Bun.stripANSI` unless the stream it writes to is a TTY. Agents read piped output, so this matters more than the color does.
- **The progress log goes to stderr, and only to a terminal.** `app.progress(tag, message)` writes `2026-10-24T10:42:07-07:00 [sync] …`, with the time from the app's clock as ISO 8601 local time with its UTC offset, to the second (not `toISOString()`, which is UTC), and a tag naming the step (`sync`, `summaries`, `judge`, `total`), only when stderr is a TTY. Stderr is where the log goes, so it's the stream that says whether a person is watching: an agent's tool shell or a pipe gets no log at all, only the final output, even when stdout is a terminal of its own. A human sees, as it happens:
  - per harness, the sources read, the sessions and events stored, and the live states found (`claude: 3 live sessions: 2 busy, 1 waiting`);
  - the summaries due and the busy roots deferred, each summary as it starts and finishes (position, id, title, duration, calls) or fails, and the summaries' totals;
  - the Opus call starting and finishing, with its duration and input tokens;
  - a `[total]` line: `done` or `half-finished`, the run's duration, then calls and input tokens per model.

  States and results are colored with the same tones as the output: `busy`, `idle`, `waiting`, `ended` through `STATE_TONES`; done and answered `finished`, failed `error`, deferred `blocked`.
- **`NO_COLOR` already works.** `Bun.color` returns an empty string when it's set, and `colorize` then returns the text unchanged.

## `status list`

The daily brief by goal. `statusList` calls `refresh`, takes `rootsInWindow` and `writeBrief` from `@src/statuses` (`src/statuses/AGENTS.md` has what the brief holds, how Opus picks each goal's status and how its answer is checked), and lays the result out.
- **Layout,** in order:
  - a tally (`Last 7 days · 3 goals need you · 1 running · 2 finished`, then `· N sessions not grouped` when any are);
  - **NEEDS YOU**, numbered in Opus's order, since the prompt asks for them in the order the user should take them;
  - **RUNNING**, numbered, with `Now:` in place of `Next:`;
  - **FINISHED**, one line per goal (its name and its single `done` item), so throwaway spikes don't crowd the page;
  - **NOT GROUPED**, when needed.
- **A needs-you or running goal** prints `Goal:`, `Done:` (bullets), `Blockers:` (bullets) and `Next:`/`Now:` (numbered) in a column 10 wide, skipping empty fields, then one `↳` footnote per session: its short id, live state and age, `+ N agents` for live subagents, and `summary behind` or `no summary`. A finished goal's footnote lists all its short ids after one `↳`, wrapping like any other text.
- **Short ids are the harness prefix and 8 characters** (`claude:ac768d0a`), lengthened one character at a time until no other stored session shares the prefix, because `status summaries get` resolves a prefix against every stored session, not only the ones in the brief.
- **Text wraps to `app.outputColumns`** (the terminal's width), or to 100 columns when piped, at word boundaries, measured with `Bun.stringWidth`. Continuation lines align under their field, list marker included. At least 30 columns are kept for text, so a very narrow terminal overflows instead of wrapping one word per line. Piped output is plain, as everywhere.
- **NOT GROUPED lists each root's headline, its objective, and its ask or open-prompt note,** since those are what the user still needs from a degraded run. When the brief failed, it lists every root, the tally counts only those, `failed: writing the brief: …` follows, and the run exits 1. When Opus only left some out, they're listed with a warning, and the run still exits 0, since every session is on screen.
- **The Opus call is logged** as `[judge] asking Opus to brief N sessions by goal`, then `answered in <duration>, <tokens> input tokens` or `failed after <duration>: <why>`.
- **No session in the window prints one line and makes no Opus call.**

## `status get <question>`

One question about the same roots, such as "what's blocked on me in lamplighter?". `statusGet` calls `refresh`, then `answerQuestion` from `@src/statuses` with the same `rootsInWindow`, and logs the call the same way as `list`.
- **The output is the answer, then a `sessions:` heading with each session's headline,** the line `list` prints under NOT GROUPED: the full id, live state, directory and branch, and age. With no sessions, it's the answer alone.
- **A failed answer prints `failed: answering the question: …` with no answer,** and exits 1.
- **A blank question fails closed** with its own reason, before the app opens.
- **No session in the window prints `list`'s one line and makes no Opus call.**

## `status summaries list` and `status summaries get`

Agents read them before they act, so their output is plain text in a stable shape: `list` is a table to scan, one row per session, and `get <id>` is the drill-down.
- **The default list is live sessions (`busy`, `idle`, `waiting`); `--all` adds ended ones whose last event is inside `--days`.** Sessions go newest-started first, then by id, so the order holds while they work.
- **`list` prints a header line (the count, and which session was left out), then a table:** `ID`, `STATE`, `ACTIVE` (age), `WAITING`, `EDITS`, `DIR`, `OBJECTIVE`.
  - `ID` is the full id, harness included (`claude:…`, `codex:…`), so it can be copied straight into `get`. Subagents form a tree in it: a listed session sits under its nearest listed ancestor, one `└ ` deeper per level.
  - In a terminal, `ID` is the shortest prefix that's unique among all stored sessions, at least the harness and 8 characters (`claude:ac768d0a`), and `ACTIVE` drops "ago" (`3m`), so the table fits a normal screen; each short id resolves through `get`'s prefix matching. Piped, ids stay full.
  - A subagent at the top level, because its parent is ended, hidden or the caller itself, starts with `↑ `, so it doesn't read as a root. The table has no parent column; `get` names its parent.
  - `WAITING` is the summary's `waiting_on` (`user`, `external`, `none`), or `behind` when the summary is behind, or `no summary`.
  - `EDITS` is how many files the session edited in the last 30 minutes, so an agent can spot a possible collision; `get` names the files.
  - `DIR` is the directory with `~` for home, then the branch in parentheses.
  - `OBJECTIVE` is the summary's objective on one line, or the title when there's no summary.
- **Columns are sized to their content, two spaces apart.** In a terminal, `OBJECTIVE` is cut to the width with `…` (at least 20 columns, so a narrow terminal wraps instead). Piped, it's printed in full, because agents read the whole objective. The width is `app.outputColumns`: stdout's width when it's a terminal, `null` when piped or when the terminal doesn't report one. This is display only; summaries' input is never cut.
- **The progress, tried, next and blockers lists, the ask and the edited file paths are only in `get`.** `get` shows one session as a headline (id, state, `active <age>`, and `summary behind` or `no summary yet`), then one `label: value` line per field, `parent:` included. A value that spans lines (an `ask` with its options, say) continues on lines indented under its label. The summary's list columns print one `- item` per line, an empty one prints `none`, and `ask` shows only with `waiting on user`.
- **The command only renders.** `readCatalog`, `listSessions`, `filesEditedBy`, `sessionsMatching`, `recentToolCalls` and `callerSessionIds` from `@src/summaries` decide which sessions are listed and where, which summaries are behind, which files count as edited and for whom, what a prefix matches and who the caller is (`src/summaries/AGENTS.md`, "The catalog"). The command keeps the options, the refresh, the table, the `get` view, the tones and widths, and the short ids, which are display only.
- **`summaries get <session_id>` brings that session's summary up to date, then shows it whatever its state:** its entry, with its subagents' edits in it, every subagent below it (a headline, title and objective each), and its last 20 tool calls oldest first, each target cut at 300 characters like a summary's input. Every printed id works with it.
  - Sync runs first over the default 7-day window, then `refresh` is scoped to that session (`{ sessionId }`): it refreshes the session and its descendants, which its summary is built from, and not its parent or anyone else. The busy-root deferral doesn't apply, because the caller asked for this session by name.
  - An unknown id fails closed after the refresh, so a session that just started is found.
  - It takes a unique prefix of an id (`claude:ac768d0a`), so short ids printed elsewhere work. An exact id always wins; a prefix several sessions share fails closed and lists them, full id and title each; matching happens after the sync.
- **Only the caller's own session is left out, never its subagents;** they sit under the caller's nearest listed ancestor, or at the top level marked `↑ ` when it has none (always, for a Claude caller, which is a root), and the header line names the session left out. When finding the Claude caller fails, a `warning:` line follows the output, since the caller may then be listed.

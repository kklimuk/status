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

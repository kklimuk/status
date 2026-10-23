# CLI

- **Arguments go through `util.parseArgs` in strict mode.** An unknown command or option fails closed: exit code 1, the reason on stderr, then the usage.
- **Commands return `{ output, exitCode }` and never write.** `src/index.ts` writes the output: to stdout on success, to stderr on failure.
- **Color goes through `colorize(text, tone)`.** A tone is a semantic name (`heading`, `error`) mapped to a color in one `TONES` table. Commands never write escape codes themselves.
- **Piped output is always plain.** `Bun.color(…, "ansi")` emits escape codes even when the output isn't a terminal, so `src/index.ts` strips them with `Bun.stripANSI` unless the stream it writes to is a TTY. Agents read piped output, so this matters more than the color does.
- **`NO_COLOR` already works.** `Bun.color` returns an empty string when it's set, and `colorize` then returns the text unchanged.

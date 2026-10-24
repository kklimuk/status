# status

See where your Claude Code and Codex sessions left off.

```bash
bun install
bun src/index.ts --help
```

It reads Claude Code sessions from `CLAUDE_CONFIG_DIR` (default `~/.claude`) and Codex sessions from `CODEX_HOME` (default `~/.codex`), and keeps its database in `STATUS_HOME` (default `~/.status`, or `<worktree>/.status` when the code runs from a linked git worktree).

## `status`: the morning triage

```bash
bun src/index.ts             # sessions active in the last 7 days
bun src/index.ts --days 2
```

It syncs, refreshes the Haiku summaries, then asks Opus to group the root sessions by goal. Each goal lists its sessions under **blocked on you**, **running** and **finished**, with the session's id (for `status summaries --session <id>`), live state, directory, branch and last activity, one line on where it stands, and, when it's blocked on you, the question it's waiting on. It exits 1 when a sync, a summary or the grouping failed, after printing what it has.

Development:

```bash
bun run check        # typecheck, lint, dead code, tests
bun run format       # apply Biome's formatting and fixes
bun run db:generate  # write a migration after changing src/database.ts
git worktree add .worktrees/<name> -b <branch>   # set up by .githooks/post-checkout
```

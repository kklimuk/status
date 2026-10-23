# status

See where your Claude Code and Codex sessions left off.

```bash
bun install
bun src/index.ts --help
```

It reads Claude Code sessions from `CLAUDE_CONFIG_DIR` (default `~/.claude`) and Codex sessions from `CODEX_HOME` (default `~/.codex`), and keeps its database in `STATUS_HOME` (default `~/.status`, or `<worktree>/.status` when the code runs from a linked git worktree).

Development:

```bash
bun run check        # typecheck, lint, dead code, tests
bun run format       # apply Biome's formatting and fixes
bun run db:generate  # write a migration after changing src/database.ts
git worktree add .worktrees/<name> -b <branch>   # set up by .githooks/post-checkout
```

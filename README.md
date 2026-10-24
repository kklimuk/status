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

## `status summaries` for agents

`status summaries` lists the live Claude Code and Codex sessions on this machine, with subagents nested under their parent. Each entry shows the session's directory and branch, its summary (objective, progress, what it tried, next steps, blockers), and the files it edited in the last 30 minutes, with those of its subagents that aren't listed on their own. It leaves out the session that runs it. Run `bun link` in this checkout to put `status` on your `PATH`.

Paste this into another repo's `AGENTS.md`:

```markdown
## Other sessions

Before you start a task, run `status summaries` to see what the other Claude Code and Codex sessions on this machine are doing.
- Look for live sessions whose `cwd` is this repo or one of its worktrees, and check their objective, `next` and "edited in the last 30m" for the files you're about to touch.
- If one is already working on the same thing or the same files, don't duplicate or overwrite its work: tell the user which session it is and ask how to proceed.
- Its `tried` list holds approaches that already failed and why. Don't repeat them.
- `status summaries --session <id>` shows one session in full: its subagents and recent tool calls. `--all` adds ended sessions.
- An entry marked `summary behind` has newer activity than its summary. Check `--session <id>` before relying on it.
```

Development:

```bash
bun run check        # typecheck, lint, dead code, tests
bun run format       # apply Biome's formatting and fixes
bun run db:generate  # write a migration after changing src/database.ts
git worktree add .worktrees/<name> -b <branch>   # set up by .githooks/post-checkout
```

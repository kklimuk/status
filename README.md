# status

**See what all your coding agents are doing, and what they need from you.**

If you run several Claude Code and Codex sessions at once, it's easy to lose track: which ones finished, which are stuck waiting on an answer from you, and which are still working. `status` reads the sessions on your machine and tells you, in one place:
- **For you,** a daily brief organized by goal: what each goal is, what got done, what's in the way, and what you should do next.
- **For your agents,** a list of the other live sessions, so an agent can check what's already in progress before it starts, and avoid redoing or overwriting another session's work.

Everything runs on your machine. `status` reads your local session history and asks Claude, through your own Claude Code login, to summarize it.

## Install

You need [Bun](https://bun.sh) and [Claude Code](https://claude.com/claude-code), signed in. Codex is optional: its sessions are included when it's installed.

```bash
git clone git@github.com:kklimuk/status.git
cd status
bun install
bun link        # puts `status` on your PATH
```

## Your daily brief

```bash
status list             # sessions active in the last 7 days
status list --days 2    # or a shorter window
```

You get your goals, with the ones that need you first, in the order to take them:

```
Last 7 days · 5 goals need you · 0 running · 3 finished

NEEDS YOU
1. Expense system monthly spending limits
   Goal:     Add per-employee monthly spending limits with custom cycles to the expense system,
             auto-declining over-limit expenses and counting only approved spend.
   Done:     - Limits built: src/limits.ts, Limit model, PUT/GET /users/:id/limit, spending_limit
               policy, auto_declined flow
             - 49 tests pass with clean tsc; /code-review fixed 8 of 10 findings; nothing committed
   Next:     1. Review the uncommitted diff
             2. Decide whether to pin TZ in vitest.config.ts so weekend tests catch local-time
                regressions anywhere
             3. Decide on a shared approval helper now or later; the session recommends waiting for
                a manager-approval endpoint
   ↳ claude:efe11ee3 · ended 22h ago

2. The Commons of Light art project
   Goal:     Grow a generative art collection, with Codex as artist and a Claude session
             critiquing; each edition is shown to you before the collection expands.
   Blockers: - Codex stopped ~44h ago on whether the open centre feels welcoming or lonely; only you
               can answer
   Next:     1. Answer whether Edition 001's open centre feels welcoming or lonely, or drop the
                project
   ↳ claude:25826490 · ended 43h ago
   ↳ codex:01a165ba · ended 44h ago

FINISHED
- agent-harness console color locations: Located STATUS_TO_COLOR in src/utils.ts:306-323 and
  markdown colors in src/cli/markdown.ts:129-131
  ↳ claude:f5eeb323
```

Each goal ends with the sessions behind it. Run `status summaries get <id>` on any of them for the full story.

Ask a specific question instead:

```bash
status get "what's blocked on me in lamplighter?"
```

## Sessions in detail

```bash
status summaries list             # live sessions, one row each
status summaries list --all       # include sessions that have ended
status summaries get claude:ac768d0a
```

`list` shows each live session's state (busy, idle, waiting on you, or ended), when it was last active, what it's waiting on, how many files it edited in the last 30 minutes, where it's working, and its objective. Subagents appear under the session that started them.

`get` shows one session in full: what it's done, what it tried that didn't work, its next steps, its blockers, the question it's waiting on you for, the files it edited and its recent activity. A short id is enough.

## Let your agents check in

Paste this into another repo's `AGENTS.md` (or `CLAUDE.md`), so its agents look before they act:

```markdown
## Other sessions

Before you start a task, run `status summaries list` to see what the other Claude Code and Codex sessions on this machine are doing.
- Look for live sessions whose DIR is this repo or one of its worktrees, with EDITS above 0 or an OBJECTIVE that overlaps your task.
- For each one, run `status summaries get <id>` before you touch the same files: it shows the files it edited, its `next` steps and what it's waiting on.
- If one is already working on the same thing or the same files, don't duplicate or overwrite its work: tell the user which session it is and ask how to proceed.
- The `tried` list in `status summaries get <id>` holds approaches that already failed and why. Don't repeat them.
- WAITING `behind` means the session has moved on since its summary; `get` brings it up to date. `status summaries list --all` adds ended sessions.
```

When an agent runs `status`, it gets plain text with no progress log. In your terminal you also see what `status` is doing as it goes.

## Good to know

- **Cost and speed:** the first run summarizes every session in the window, which takes a few minutes and uses a modest number of Claude calls. After that, only sessions with new activity are re-summarized, so a run usually takes seconds. `status list` and `status get` each make one more call to write the brief or the answer.
- **Your data:** your session history stays on your machine. The summaries live in `~/.status`. Delete that folder to start fresh. Summarizing sends session content to Claude through your Claude Code login, as Claude Code itself does.

## Getting help

Run `status` on its own to see every command:

```
$ status
usage: status list [--days <n>]
       status get <question> [--days <n>]
       status summaries list [--days <n>] [--all]
       status summaries get <session_id>
...
```

Every command has its own help, with its options and what it does:

```bash
status --help                 # all commands (same as plain `status`)
status list --help            # the daily brief
status get --help             # asking one question
status summaries              # the session commands
status summaries list --help
status summaries get --help
```

## Development

```bash
bun run check   # types, lint, dead code, tests
```

How it's built, and the rules for changing it, are in [`AGENTS.md`](AGENTS.md).

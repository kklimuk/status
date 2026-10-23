# status

`status` reads local Claude Code and Codex session transcripts, normalizes them into `~/.status/status.db`, and reports what each session is doing: finished, blocked on the user, or still running. People run `status` for a morning triage. Agents run `status summaries` to see what other sessions are already doing before they act.

## Stack and commands

- **Runtime is Bun.** Use `bun <file>`, `bun test`, `bun install` and `bunx`; not Node, npm, jest or vitest. Bun loads `.env` itself.
- **SQLite is `bun:sqlite` through Drizzle** (`drizzle-orm/bun-sqlite`). `bun run db:generate` writes migrations into `drizzle/` from the schema in `src/database.ts`.
- **Prefer Bun's APIs:** `Bun.file` over `node:fs` reads and writes, `Bun.$` for shell commands, `Bun.spawn` for child processes.
- **`bun run check` must pass before every commit.** It runs, in order:
  - `bun check`: type checking, the same errors as `tsc`.
  - `biome check --error-on-warnings`: formatting, imports and lint. `bun run format` fixes what it can.
  - `knip`: unused files, exports and dependencies.
  - `bun test`.

## Layout

- `src/index.ts` is the executable. It runs the CLI and writes its output.
- `tests/` shadows `src/`: the tests for `src/harnesses/claude.ts` live in `tests/harnesses/claude.test.ts`. Shared test helpers live in `tests/utils.ts`, imported as `@tests/utils`.
- Tests never read the real `~/.claude`, `~/.codex` or `~/.status`. Build fixtures in a temporary directory.

## Worktrees

- **Create worktrees under `.worktrees/`:** `git worktree add .worktrees/<name> -b <branch>`. Remove them with `git worktree remove .worktrees/<name>`.
- **`bun install` points git at `.githooks/`,** through the `prepare` script.
- **`.githooks/post-checkout` sets up each new worktree.** It writes `STATUS_HOME=<worktree>/.status` into the worktree's `.env`, so a worktree never writes to the real `~/.status`, then runs `bun install --frozen-lockfile`. Bun loads that `.env` for `bun test` too.
- **The hook comes from the checkout that runs `git worktree add`,** not from the branch being checked out: git resolves the relative `core.hooksPath` there. A worktree of a commit that predates `.githooks/` still gets set up, and a checkout without `.githooks/` sets up nothing.
- **The main checkout's checks skip `.worktrees/` and `.claude/worktrees/`.** `tsconfig.json` includes only `src`, `tests` and root `*.ts` files, Biome and Knip follow `.gitignore`, and `bun test` skips dot-directories. A worktree anywhere else inside the repo breaks `biome check` with a nested root configuration.

## Principles

The rules below are the _how_; these are the _why_. When a rule and a situation conflict, reason from the principle.
- **Be direct and concise, without being enigmatic.** When answering a human, work out the minimum context they need, then say it in a straightforward, compact way. Use bullets, diagrams and headings. Don't assume the reader knows every concept; gauge from their response.
- **Lead with the point.** Open any explanation with what the change is and why it happened. Put background and mechanics after that.
- **Reading down should be enough.** Control flow and purpose should be clear without following calls or hopping between files. Split code when a real unit of meaning earns a name, not to meet a line count.
- **Least astonishment.** The reader's expectation is the spec. Remove surprises from names, structure and behavior.
- **The wrong abstraction costs more than duplication.** Inline a thing two or three times before extracting it. Duplication is easier to remove than a dependency on the wrong shape.
- **Use what exists before building infrastructure.** `util.parseArgs`, Drizzle and Bun's APIs already do the job. Don't wrap them in a layer of our own.
- **Understand the fence before you remove it.** Find the invariant before changing or deleting code. Once you know it no longer applies, remove the code freely.
- **Fail closed.** A command that can't do its job exits non-zero and says why. A check that can't run doesn't pretend it passed. A half-finished run reports as half-finished.
- **One source of truth.** A constant, registry or contract has one owner:
  - `src/database.ts` owns the schema. Each table's accessors live in its owning feature.
  - `@src/harnesses` owns the session contract (`SessionRecord`, `SessionEvent`, `HarnessAdapter`).
  - `src/cli/index.ts` owns the command list, and `src/app.ts` owns what every command receives.
- **YAGNI.** Don't add structure for a need the project doesn't have yet.

## Rules

- **Group code logically.** Keep a type next to the code that uses it, and keep a feature's accessors and logic together in its `index.ts`. Add a sibling file only for a unit with its own meaning (`harnesses/claude.ts`, `harnesses/codex.ts`), never one per helper or type.
- **Shared helpers have one home each.** Helpers used across features live in `src/utils.ts`. Helpers shared within one feature live in `<feature>/utils.ts`. Everything else stays in the file that uses it.
- **Top-down file ordering.** Put exports first, exported types and constants included, then their direct dependencies. Write internal helpers as hoisted `function` declarations, so reading down shows the structure. Internal constants and types go after the functions that use them.
- **Path aliases across features.** Import across features through `@src/*`, and import shared test helpers through `@tests/*`. Inside a feature, use relative imports.
- **Descriptive names.** No one- or two-letter names: `database`, not `db`; `transaction`, not `txn`; `row`, not `r`. No Java-style names either: `app`, not `applicationServices`.
- **Comments are default-deny.** Names and control flow carry the meaning, and design rationale goes in the nearest `AGENTS.md`. The only ordinary source comment allowed is a terse single-line `// fact:` note for an external fact you can't express any other way. Tooling directives (`biome-ignore`, `@ts-*`) are still allowed.
- **Console calls are default-deny in `src/` and `tests/`.** Biome enforces this. Commands return the text to print, and `src/index.ts` writes it, in color only to a terminal (`src/cli/AGENTS.md`). Progress on a slow step goes through `app.progress`. Scripts and probes written for a human may print to the terminal.
- **Prefer early returns** when they make the branches easier to follow.
- **Ternaries are one-line and two-armed.** Don't nest them. Use `if` or early returns once they wrap or branch again.
- **File names are kebab-case.** A command's file is named after the command, inside a folder for its group when the group has several (`commands/summaries.ts` for `status summaries`). Any other file is named after its primary export or its subject (`claude.ts`).
- **Every feature has one public door, its `index.ts`.** External callers import through it (`@src/harnesses`, not `@src/harnesses/claude`). The door re-exports its sibling files with `export * from`. To expose more, export it from the sibling; never reach into an internal file. `src/cli` is the top layer: only `src/index.ts` and tests import it.
- **Use function declarations** for exported functions and helpers. Arrows are for inline callbacks, short utilities, and values checked against a named function type.
- **Style:** tabs and double quotes, enforced by Biome.
- **Tests:** add focused coverage for important behavior and regressions. Don't add tests that only restate the implementation.

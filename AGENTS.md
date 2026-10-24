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

- **`src/index.ts` is the executable.** It runs the CLI with `createApp` and writes the output.
- **`src/app.ts` owns `App`, what every command receives:**
  - the database;
  - `paths`, from `STATUS_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (defaults `~/.status`, or `<worktree>/.status` in a linked worktree, then `~/.claude` and `~/.codex`);
  - the harness adapters;
  - `now()`;
  - `progress`, which writes a line to stderr only when stderr is a terminal;
  - `askClaude`.

  `createApp(environment)` builds it and opens `<status>/status.db`.
- **`src/harnesses/` owns the session contract** and one adapter per harness (`src/harnesses/AGENTS.md`).
- **`src/sync/` pulls what the adapters read into `sessions` and `events`** and owns every write to them (`src/sync/AGENTS.md`).
- **`src/summaries/` keeps one rolling Haiku summary per session,** subagents included, each subagent's feeding its parent's, and owns every read and write of `summaries`, except that sync deletes the summary of a session it drops as continued (`src/summaries/AGENTS.md`).
- **`src/database.ts` owns the schema,** and `drizzle/` holds its generated migrations.
- **`src/utils.ts` holds `askClaude`,** the `claude -p` runner.
- **`src/cli/` parses arguments and runs the commands** (`src/cli/AGENTS.md`).
- **`tests/` shadows `src/`:** the tests for `src/harnesses/claude.ts` live in `tests/harnesses/claude.test.ts`. Shared test helpers live in `tests/utils.ts`, imported as `@tests/utils`. Call them inside a test or a `beforeEach`, because they clean up with `onTestFinished`:
  - `createTemporaryHome()` makes empty `.status`, `.claude` and `.codex` directories, and returns their paths plus an `environment` that points `createApp` or a spawned CLI at them.
  - `createTestApp(overrides)` builds a real `App` on a temporary home, with a silent `progress` and an `askClaude` that rejects. Pass your own fake `askClaude`, `now` or `adapters` as overrides.
- **Tests never read the real `~/.claude`, `~/.codex` or `~/.status`.** Build fixtures in a temporary directory.

## Database

- **After a schema change, run `bun run db:generate`** and commit the new migration in `drizzle/` with it. The script runs drizzle-kit under Bun (`bun --bun`), because the schema imports `bun:sqlite`, which Node can't load.
- **`openDatabase` runs the migrations on every open.** It finds `drizzle/` relative to its own file, so it works from any working directory.
- **A failed migration is retried once.** Drizzle's migrator reads which migrations are applied before it opens its transaction, so two runs that open a database with pending migrations at once both try to apply them. The second one's DDL fails ("table already exists") and rolls back, and the retry finds the migrations applied. A real failure fails the retry too.
- **`foreign_keys` goes on after the migrations.** drizzle-kit rebuilds a table to change a column, between `PRAGMA foreign_keys=OFF` and `ON`, but Drizzle runs the migrations inside one transaction, where those pragmas do nothing. With keys on, dropping `sessions` for a rebuild fails on the events that reference it.
- **`busy_timeout` is set before `journal_mode = WAL`,** so a run that meets a locked database waits for it instead of failing.
- **Times are integer milliseconds** (`timestamp_ms` columns), read back as `Date`.
- **Event ids are ingest order,** and summaries track how far they've read by `events.id`. Update a stored row in place (`onConflictDoUpdate`). `INSERT OR REPLACE` deletes the row and inserts a new one, which renumbers an event, and it fails on a session that other rows reference.
- **`parent_id` has no foreign key,** because a subagent's parent can fall outside the window. `events` and `summaries` do reference `sessions`.

## Calling Claude

- **`askClaude` runs `claude -p` with the input on stdin** and returns `.structured_output` plus two token counts, each `input_tokens`, cache reads and cache writes added together. On a cached prompt, `input_tokens` alone is a handful.
  - **`inputTokens` is what the call billed:** the CLI's top-level `usage`, which sums every API request the call made.
  - **`largestPromptTokens` is the largest single prompt it sent:** the last entry of `usage.iterations`. That entry is the call's last request, and it carries every earlier turn, so it's the largest. When `iterations` is absent, it falls back to `inputTokens`.
  - **The two differ when the CLI retries.** A `StructuredOutput` answer that fails the `--json-schema` check goes back to the model as a tool error, and the CLI sends the whole prompt again, so `usage` counts it twice. One summary call saw requests of 3,244 and 4,615 tokens and a `usage` of 7,859.
  - **Haiku's 100,000-token price tier applies per request,** so compare `largestPromptTokens` against it, not `inputTokens`.
- **`--strict-mcp-config` is essential.** Without it, every call loads every configured MCP server's tool definitions: about 115k tokens of overhead on a one-sentence input, against about 1.1k with it.
- **`--setting-sources ""` keeps the caller's project out of the call.** Without it, `claude -p` loads the `CLAUDE.md` and `AGENTS.md` of the directory `status` runs from and every parent, plus settings hooks and plugins. From inside this repo that added about 4.5k tokens to a one-line call, and the project's rules would steer the summaries. A hook that runs `status` could even recurse. The OAuth login still works with it.
- **Never pass `--bare`.** It skips the OAuth login and fails with "Not logged in".
- **`--no-session-persistence` writes no transcript,** so `status` never ingests its own calls.
- **It fails closed** when the CLI exits non-zero, is killed (calls time out after 10 minutes), reports `is_error`, or returns no structured output.
- **Tests never call the real CLI:**
  - Give `createTestApp` a fake `askClaude`.
  - Test `askClaude` itself against a fake executable, passed as its second argument. Bun resolves executables from the `PATH` the process started with, so prepending a fake to `process.env.PATH` silently runs the real `claude`.
  - A test that spawns `src/index.ts` sticks to `--help` and argument errors, because a real command run would call the real CLI.

## Worktrees

- **Create worktrees under `.worktrees/`:** `git worktree add .worktrees/<name> -b <branch>`. Remove them with `git worktree remove .worktrees/<name>`.
- **`bun install` points git at `.githooks/`,** through the `prepare` script.
- **A worktree's code keeps its own database.** When the running code lives in a linked worktree (its `.git` is a file whose `gitdir` ends in `worktrees/<name>`; a submodule's `.git` file points into `modules/` instead), `createApp` defaults `STATUS_HOME` to `<worktree>/.status`, whatever the current directory. An explicit `STATUS_HOME` still wins, and the main checkout defaults to `~/.status`. This lives in code rather than a `.env` file because Bun only loads `.env` from the current directory.
- **`.githooks/post-checkout` sets up each new worktree.** It runs `bun install --frozen-lockfile`, then creates and migrates the worktree's database and prints its path. Either step failing fails the hook. A commit without `src/app.ts` skips the database step, so it still gets set up.
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
- **Functions first, types and constants last.** A file opens with the functions that do its work: exported functions first, then the helpers they call, in the order they're called, written as hoisted `function` declarations so reading down shows the structure. Types and constants go at the bottom, exported ones included. A file that only declares types (the contract in `src/harnesses/index.ts`) leads with its main type.
- **Name every database read.** Logic calls a selector whose name says what it returns (`summariesBySession(database)`, `newestEventIdBySession(database)`, `childrenOf(database, sessionId)`) instead of building a query inline. Selectors are small functions below the logic that uses them, in the feature that uses them, and they return plain rows or maps. When a second feature needs the same selector, it moves to the table's owner.
- **Path aliases across features.** Import across features through `@src/*`, and import shared test helpers through `@tests/*`. Inside a feature, use relative imports.
- **Descriptive names.** No one- or two-letter names: `database`, not `db`; `transaction`, not `txn`; `row`, not `r`. No Java-style names either: `app`, not `applicationServices`.
- **Comments are default-deny.** Names and control flow carry the meaning, and design rationale goes in the nearest `AGENTS.md`. The only ordinary source comment allowed is a terse single-line `// fact:` note for an external fact you can't express any other way. Tooling directives (`biome-ignore`, `@ts-*`) are still allowed.
- **Knip's `/** @public */` is for an export that only a later change will import,** and that change removes it. Knip already accepts an export used in its own file (`ignoreExportsUsedInFile`), so a type that only appears in an exported signature needs no tag.
- **Console calls are default-deny in `src/` and `tests/`.** Biome enforces this. Commands return the text to print, and `src/index.ts` writes it, in color only to a terminal (`src/cli/AGENTS.md`). Progress on a slow step goes through `app.progress`. Scripts and probes written for a human may print to the terminal.
- **Prefer early returns** when they make the branches easier to follow.
- **Ternaries are one-line and two-armed.** Don't nest them. Use `if` or early returns once they wrap or branch again.
- **File names are kebab-case.** A command's file is named after the command, inside a folder for its group when the group has several (`commands/summaries.ts` for `status summaries`). Any other file is named after its primary export or its subject (`claude.ts`).
- **Every feature has one public door, its `index.ts`.** External callers import through it (`@src/harnesses`, not `@src/harnesses/claude`). The door re-exports its sibling files with `export * from`. To expose more, export it from the sibling; never reach into an internal file. `src/cli` is the top layer: only `src/index.ts` and tests import it.
- **Use function declarations** for exported functions and helpers. Arrows are for inline callbacks, short utilities, and values checked against a named function type.
- **Style:** tabs and double quotes, enforced by Biome.
- **Tests:** add focused coverage for important behavior and regressions. Don't add tests that only restate the implementation.

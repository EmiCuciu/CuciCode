# Decisions

Short architecture decision records. Newest last.

## 1. Use the author's subscription login, never touch credentials (2026-11-16)

**Context.** The Agent SDK drives the Claude Code binary, which already holds the author's login. Anthropic's terms forbid third-party developers from offering claude.ai login to their users or handling their credentials; a personal, undistributed app is not addressed explicitly.

**Decision.** Use the existing login, under three conditions: CuciCode never reads or stores `.credentials.json` or any token; it runs only the unmodified binary bundled with the SDK; it is not distributed to others with subscription auth.

**Consequence.** The sidecar strips credential environment variables so the login is used. Sharing the app with teammates needs API keys or a confirmation from Anthropic first.

## 2. One `query()` in streaming-input mode per chat (2026-11-16)

**Context.** The SDK's experimental session API (`createSession`/`send`/`stream`) was removed. `query()` accepts either a single prompt or an async stream of user messages; only the stream form supports interrupting, changing model and changing permission mode on a live session.

**Decision.** Each open chat owns one `query()` fed by an in-memory queue. Sessions are resumed by explicit session ID, never by "most recent in this directory".

**Consequence.** Several chats can run at once, each as its own Claude Code process.

## 3. "Queue" and "Interrupt and send" instead of "steer" (2026-11-16)

**Context.** The documented SDK processes user messages one after another; there is no documented way to inject an instruction into a turn that is already running.

**Decision.** While an agent is running, the UI offers Queue (processed after the current turn) and Interrupt and send.

**Open point.** The SDK's types include an undocumented `priority: 'now' | 'next' | 'later'` field on user messages. The protocol already carries it; whether `now` gives true mid-turn steering is to be tested.

## 4. CuciCode's own settings live in `.claude/cucicode/` (2026-11-16)

**Context.** The docs list the paths Claude Code reads inside `.claude` but do not say what happens to unknown folders.

**Decision.** Keep `cucicode/settings.json` and `cucicode/settings.local.json` inside `.claude` at user and project scope.

**Evidence.** Tested with Claude Code 2.1.325: a project with `.claude/cucicode/settings.json` containing a bogus `model` and a `permissions` block ran normally, printed no warnings, did not apply the values and left both files byte-identical.

## 5. Normalise SDK messages in the sidecar (2026-11-16)

**Context.** The SDK emits about forty message types, some of them large and versioned with Claude Code.

**Decision.** The sidecar converts them to a small set of typed timeline events defined in `packages/protocol`. Rust forwards events without interpreting them. Unknown message types become `raw` events rather than being dropped.

**Consequence.** An SDK upgrade touches one file (`normalize.ts`) and its tests. The UI never depends on SDK types.

## 6. Session history through the SDK, not by parsing transcripts (2026-11-16)

**Context.** Transcript files under `~/.claude/projects` are documented as an internal format that may change.

**Decision.** List, read, rename, fork and delete sessions with the SDK's functions (`listSessions`, `getSessionMessages`, `renameSession`, `forkSession`, `deleteSession`). Full-text search, which the SDK does not offer, will read the files behind a single adapter.

## 7. Windows first (2026-11-16)

**Context.** The spec said macOS first; the author's machine is Windows 11.

**Decision.** Develop and test on Windows. Avoid Windows-only APIs without a fallback so macOS and Linux stay possible.

## 8. npm workspaces, exact versions (2026-11-16)

**Decision.** One repository with npm workspaces (`packages/*`, `sidecar`, `apps/*`). `.npmrc` sets `save-exact=true`; Rust crates are pinned with `=` requirements.

## 9. Git through the `git` command line, not libgit2 (2026-11-16)

**Context.** The Rust core needs branch, clean/dirty and remote for each project now, and worktrees, diffs and merges later. The `git2` crate (libgit2) has limited worktree support and can behave differently from the user's own git (credentials, config, hooks).

**Decision.** Run the installed `git` and parse its machine-readable output (`status --porcelain=v2 --branch`).

**Consequence.** CuciCode behaves exactly like git in the user's terminal and needs no native build step for git. The parsing functions are pure and unit-tested.

## 10. How effective settings are computed (2026-11-16)

**Context.** The UI must show each setting's effective value and the scope and file it comes from. The docs state that scalars are overridden by the higher scope and that lists such as `permissions.allow` are combined across scopes; they do not say how nested objects or hooks combine.

**Decision.** `settings/claude.rs` resolves in this order: managed, project local, project, user. A scalar takes the highest scope that defines it. Lists are combined, highest first, without duplicates. Objects are resolved one level deep, so `permissions.allow` and `env.NAME` are separate rows. Within the managed tier the first source present wins: machine policy (Windows registry HKLM), then `managed-settings.json` with its drop-in directory, then user policy (HKCU).

**Limits.** Server-managed settings delivered by claude.ai are not read, and command-line `--settings` does not apply to a UI. The one-level object rule is an assumption to confirm by experiment before Phase 2 makes settings editable.

## 11. The sidecar runs from the repository in development (2026-11-16)

**Decision.** The Rust core starts `node sidecar/dist/sidecar.mjs`, located relative to the source tree (overridable with `CUCICODE_SIDECAR` and `CUCICODE_NODE`). The sidecar starts on the first request and is restarted on the next request if it exits.

**Consequence.** Installer packaging (bundling Node and the SDK next to the executable) is not done; bundling is switched off in `tauri.conf.json` until then.

## 12. The Toolkit reads files itself but changes shared state through Claude Code (2026-11-16)

**Context.** The Toolkit must list everything Claude Code can load and let the user change it. Some of it is plain files CuciCode can own (agents, skills, commands, output styles, rules, settings files). Some lives in files Claude Code rewrites all the time or manages with its own logic: MCP servers in `~/.claude.json`, installed plugins, marketplaces.

**Decision.** Scanning is done in Rust by reading files directly (`toolkit/`), which is fast and works with no session running. Markdown items and settings keys are written directly, at the scope the user picks. MCP servers, plugins and marketplaces are changed only by running the `claude` command (`claude mcp add-json`, `claude plugin install`, `claude plugin marketplace add`, ...), wrapped in `claude_cli.rs`.

**Consequence.** CuciCode never corrupts `~/.claude.json` and automatically follows Claude Code's own rules for plugins. The cost is that those actions are slower and their errors are the CLI's text. Plugin and managed items are read-only; "Duplicate" copies one into a scope the user owns.

## 13. Precedence rules are encoded once, with their source stated (2026-11-16)

**Decision.** `toolkit/conflicts.rs` holds the order in which same-named items win: agents and output styles (managed, project, user, plugin), skills (managed, user, project), MCP servers (local, project, user, plugin), and "a skill beats a command of the same name". Each conflict shown in the UI carries the rule as a sentence.

**Limit.** The order for two commands with the same name is not documented; CuciCode assumes it follows skills and says so in the UI.

## 14. Secrets go to the OS keychain and are referenced as `${NAME}` (2026-11-16)

**Context.** `.mcp.json` is usually committed, so tokens must not be written into it. Claude Code expands `${VAR}` in MCP configuration from its environment.

**Decision.** In the add-server form, a value marked secret is stored in the OS keychain (`secrets.rs`, service `cucicode`) and the configuration gets `${NAME}` instead. Only the list of secret names is kept in `~/.claude/cucicode/settings.json`. When CuciCode starts a session, the Rust core adds the secrets to that session's environment; the values never pass through the UI.

**Consequence.** The committed file is safe. The trade-off against "identical in a terminal": a terminal `claude` needs the same variables set by the user, and the form says so.

## 15. Settings forms come from a vendored copy of the published schema (2026-11-16)

**Decision.** `apps/desktop/src/assets/claude-code-settings.schema.json` is a copy of `https://json.schemastore.org/claude-code-settings.json` (142 keys). The settings screen builds its list, descriptions and input types from it; keys found in files but missing from the schema are still shown and editable as JSON.

**Consequence.** No network access at run time and no hand-written form per setting. The copy must be refreshed when Claude Code adds settings. Writing a setting replaces one top-level key in one scope's file and leaves the rest of the file, including key order, untouched.

## 16. Pipeline stages are plugin skills; CuciCode only sequences them (2026-11-16)

**Context.** The pipeline (brainstorm, plan, stories, build, review) could be coded inside the app, or expressed in Claude Code's own terms.

**Decision.** Each stage is a skill in the CuciCode plugin (`/cucicode:plan`, `/cucicode:stories`, `/cucicode:build`, `/cucicode:fix`, `/cucicode:review`, `/cucicode:onboard`) and each role is a normal subagent file. Stages hand off through files (`Plans/`, `Stories/`), never through conversation history. The app sends the stage's slash command and waits at checkpoints.

**Consequence.** The whole workflow runs from a plain `claude` terminal with the plugin installed. Sessions can be cleared between stages, which keeps context small.

## 17. The pipeline engine is a pure function, separate from the driver (2026-11-16)

**Decision.** `features/workflow/pipeline.ts` exports `step(run, event, config)`, which returns the next run and a list of effects (`send_main`, `start_worker`, `run_checks`, `merge`, ...). It performs nothing. `workflowStore.ts` is the driver: it performs the effects (sessions, worktrees, checks, merge) and feeds results back as events.

**Consequence.** Every rule is unit-tested without running an agent: approval gates, the parallel limit, dependency order, the fix-round limit, "no review before checks pass". The run is saved to `.claude/cucicode/pipeline.local.json` after each step.

## 18. CuciCode creates the story worktrees and runs one session per story (2026-11-16)

**Context.** The spec was first amended to use Claude Code's `isolation: worktree` for the worker subagent. That hides the worktree's path and branch from the app, which then cannot run checks in it, show its diff or merge it.

**Decision.** CuciCode creates `.claude/worktrees/<story-id>` on branch `story/<story-id>` (the same folder Claude Code uses for its own worktrees) and starts a separate session there for each story. The worker agent file keeps `isolation: worktree` for terminal use.

**Consequence.** Each worker has its own timeline, stories run in parallel up to a limit, and diff, merge and discard are plain git on a known branch. Plan and story files are committed before building, because a worktree only contains what is committed. On Windows the worker's process is ended before its folder is removed, since a running process locks its working directory.

## 19. The app verifies; it does not trust an agent's report (2026-11-16)

**Decision.** After every worker turn CuciCode commits the worktree itself, then runs the project's check commands itself (`checks.rs`) and reads the exit codes. Reviewers start only when all checks pass. Failing output goes back to the worker, up to a configurable number of rounds; after that the story stops and appears in the Inbox.

**Consequence.** Review is never spent on code that does not build, and a worker cannot pass by claiming success. Check commands are auto-detected from the project's build files and can be overridden per project.

## 20. Workers get narrow permissions, not a bypass (2026-11-16)

**Context.** A worker must edit files, run the checks and commit without stopping for every prompt. Running it with all permissions bypassed would remove the protection the user relies on.

**Decision.** Worker sessions use `acceptEdits` plus session-only allow rules for exactly the project's check commands and basic git (`status`, `diff`, `log`, `show`, `add`, `commit`). Anything else still raises a permission request, which appears in the Inbox. Protected paths are enforced by a plugin hook that runs regardless of permission mode.

**Evidence.** Verified with real runs: without the rules the worker was denied `npm test` and `git commit`; with them it tested and committed, and compound shell commands outside the rules were still denied.

## 21. A turn ended by the usage limit is not a finished turn (2026-11-16)

**Context.** When the subscription window runs out, Claude Code ends the turn with a `success` result whose text is "You've hit your 5-hour limit". Treated as success, the pipeline would run checks and review on work that was never done.

**Decision.** The driver watches for the `rate_limit` event with status `rejected` (and, as a fallback, the limit message itself) and reports that turn as stopped. A main-thread stage waits with a "Run it again" action; a story is marked failed with the reason and can be retried.

## 22. A subagent role's model is changed in the agent's own file (2026-11-16)

**Context.** The routing table lets the user set model and effort per role. For the main thread and workers CuciCode starts the session and can pass those values. Subagent roles (planner, story writer, explorer, reviewers) are started by Claude Code, which reads the model from the agent file.

**Decision.** For subagent roles the table edits the `model` and `effort` lines of the agent file (`features/toolkit/frontmatterEdit.ts`). If the role uses a read-only agent, such as CuciCode's own, the agent is first copied into the project's `.claude/agents` and the role is pointed at the copy. The same copy step is the "create a new one from CuciCode's template" choice.

**Consequence.** There is no CuciCode-only model override: the terminal sees exactly what the table shows. The cost is that changing a model on a plugin agent creates a project file.

## 23. Two kinds of rewind (2026-11-16)

**Decision.** In a chat, "rewind files to here" on a user message uses Claude Code's file checkpointing (`enableFileCheckpointing`, `Query.rewindFiles`) with a dry-run preview first. In the pipeline, every worker turn is a git commit on the story branch, and "rewind to here" resets the branch to one of them (`git_ops::story_reset`).

**Limits.** File checkpointing restores files changed by Claude's edit tools only, not by shell commands or subagents, and does not rewind the conversation. The story reset accepts only commits between the story's branch point and its head.

**Evidence.** `sidecar/scripts/rewind-smoke.ts` runs a real session that creates a file, previews the rewind, applies it and checks the file is gone.

## 24. Pull requests through the host's API, with a token the agents never see (2026-11-16)

**Decision.** With push mode "pull request", approving a story pushes its branch with the user's normal git credentials and opens a pull request through the GitHub or Bitbucket REST API (`git_host.rs`) instead of merging locally. The API token is stored in the OS keychain under a `CUCICODE_` name. Secrets with that prefix are excluded from the environment given to sessions.

**Limits.** Stories that depend on a story sent as a pull request start from the base branch without its changes until it is merged on the host. "Require CI before merge" is left to the host's branch protection, because CuciCode does not merge pull requests. The API calls are unit-tested for request shape and response parsing but have not been run against a live host.

## 25. Onboarding an existing project uses the same engine (2026-11-16)

**Decision.** Map, baseline, scope, audit and backlog are a second stage list in the same state machine (`kind: 'onboard'`). Each stage sends `/cucicode:onboard <stage>` to the main thread, writes one file under `Plans/onboarding/`, and always waits for approval, because each stage's output is what the next one trusts.

## 26. Usage figures come from Claude Code's own cache and from transcripts (2026-11-17)

**Context.** The spec asked for the 5-hour window and weekly limit, labelled as estimates if no exact figure is available. The SDK only reports limits when their state changes (`rate_limit_event`), and there is no documented usage API.

**Finding.** Claude Code stores the last utilisation it fetched from Anthropic in `~/.claude.json` (`cachedUsageUtilization`: percentage and reset time for the 5-hour and 7-day windows, plus the fetch time). This is an undocumented internal field.

**Decision.** Show those percentages as "reported" with the time they were fetched, mark a window as stale once its reset time has passed, and label the run-out projection an estimate. Token breakdowns are counted from transcripts, reading each assistant message's `usage` once (a message can appear on several lines). Both readers are isolated in `usage.rs`, so a format change touches one file.

**Consequence.** No CuciCode-side accounting is needed, and the numbers match what Claude Code itself shows. If Claude Code stops caching the figures, the meters show "no data" and the token tables still work.

## 27. Code Rules guidance is a project rules file, not plugin content (2026-11-17)

**Context.** The spec said Code Rules are stored in the CuciCode plugin. Claude Code does not load instruction files from plugins, and installed plugins are read-only copies.

**Decision.** Guidance rules live in `.claude/rules/cucicode-code-rules.md`, created and edited from Settings → Workflow. Enforcement stays in the plugin as hooks, because hooks are code that must run in every session, including the terminal.

**Consequence.** The rules are loaded natively, can be committed for the team, and the code-rules reviewer reads them with the rest of `.claude/rules/`. The hook tests run real files through the same script Claude Code runs.

## 28. "Explain" is built from the event, not asked of a model (2026-11-17)

**Decision.** Each explanation is assembled from the event's own fields (which tool, which hook and its exit code, token counts before and after compaction) plus a link to a Concepts page written from the documentation.

**Consequence.** Explain is instant, always the same for the same event, costs no usage, and cannot invent behaviour. It cannot answer follow-up questions; for that, ask in the chat.

## 29. The terminal pane is a real shell, used for terminal-only commands (2026-11-17)

**Decision.** `portable-pty` runs the user's shell; `xterm.js` renders it. The commands that need it are taken from Claude Code's own `terminal_slash_commands` list rather than a hardcoded one, and open as `claude '/command'`, a new terminal session that does not resume the chat's session (two processes writing one session would diverge).

**Finding.** On Windows, ConPTY asks the terminal for the cursor position (`ESC[6n`) at start-up and waits for the answer before producing any output. xterm.js answers it automatically; the test that runs a real command through ConPTY answers it explicitly.

## 30. The new-project wizard reports each step and never rolls back (2026-11-17)

**Decision.** Local steps run in one Rust call that returns a result per step; remote creation, plugin installation and opening the project follow as separate calls. A failed step is shown with its error and the earlier steps are kept.

**Consequence.** A half-created project is visible and fixable rather than silently deleted, which matters once a remote repository exists. The starter templates are minimal and each passes its own test command (verified for Node in a test). Remote creation through the GitHub and Bitbucket APIs is tested for request shape only, not against a live host.

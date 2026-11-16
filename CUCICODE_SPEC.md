# CuciCode — build spec & prompt

You are building **CuciCode**, a desktop app that wraps Claude Code and makes an agentic development workflow visible, controllable and cheap on usage. CuciCode is only a UI: Claude Code does all the work, and all configuration lives where Claude Code keeps it (`.claude`). A project configured in CuciCode must behave identically when opened with `claude` in a terminal. It is a personal tool and a learning exercise: the author wants to understand how Claude Code works (agents, skills, hooks, MCP, context, usage) while building it, and will present it to a team lead. Code quality, clear architecture and explainability matter as much as features.

## 0. Ground rules for you (read first)

1. **Verify before you build.** Before writing code, read the current official docs for: the Claude Agent SDK (TypeScript), Claude Code settings and their precedence, hook events and their payloads, subagent and skill file formats, plugins and plugin marketplaces, output styles, MCP configuration, session transcripts on disk, and how subscription (Pro/Max) authentication works with the SDK. Do not invent APIs, flags, event names or file formats. If something in this spec is impossible or works differently, say so and propose the closest alternative.
2. **Auth:** this app runs only on the author's machine with their own Claude Pro/Max login through the locally installed `claude` CLI. Confirm this is allowed by current terms and how the SDK picks up that login; report back before Phase 1.
   - *Decided 2026-11-16:* use the author's subscription login, under three conditions: CuciCode never reads or stores `.credentials.json` or any token; it only runs the unmodified Claude Code binary bundled with the SDK; it is not distributed to others with subscription auth (teammates would need API keys or a confirmation from Anthropic). The sidecar strips `ANTHROPIC_API_KEY` from the environment so the subscription login is used.
3. **Start with a plan.** Output: architecture overview, folder structure, the list of assumptions you made, and open questions. Wait for approval.
4. **Work in phases** (section 12). Stop after each phase with a short demo script and wait for review.
5. Keep `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` (short ADRs) up to date; they will be used in the presentation.
6. Pin every dependency to an exact, established version.

## 1. Stack

- **Tauri 2.** Rust backend owns: filesystem scanning and watching (`notify`), git and worktrees, process management, OS keychain, notifications, local speech-to-text.
- **Frontend:** React + TypeScript + Vite, Tailwind, Zustand. Dark theme first (reference look: a calm, dense, monospace-accented dashboard), light theme supported.
- **Agent runtime:** a Node sidecar running the Claude Agent SDK. Rust ↔ sidecar over stdio with newline-delimited JSON; Rust forwards events to the UI via Tauri events. One SDK `query()` with streaming input per active chat, resumed by explicit session ID; sessions can run concurrently across projects.
- **Voice:** local push-to-talk transcription with `whisper-rs` (whisper.cpp), model downloaded on first use; no cloud STT.
- **Terminal pane:** `xterm.js` + `portable-pty`, as a fallback to raw `claude`.
- Windows first (the author's machine is Windows 11); keep macOS/Linux possible (no Windows-only APIs without a fallback).

## 2. Settings: single source of truth

- Everything that is a **Claude Code setting** (models, effort, permissions, hooks, MCP servers, env, output style, etc.) is read from and written to Claude Code's **native files** at the correct scope (managed, user, project, project-local). CuciCode never keeps a shadow copy.
- **CuciCode is Claude Code with a UI, so everything lives in `.claude`.** Rule of thumb: if Claude Code has a native way to express something (settings, subagents, skills, hooks, commands, output styles, CLAUDE.md, plugins), use it. Only what Claude Code has no concept of (UI layout, timeline filters, pipeline checkpoints, role routing table, budgets, stories target) goes into CuciCode's own files, mirroring Claude Code's scope convention:
  - `~/.claude/cucicode/settings.json` — user-wide
  - `<project>/.claude/cucicode/settings.json` — per project, can be committed
  - `<project>/.claude/cucicode/settings.local.json` — personal per-project overrides, added to `.gitignore`
- Never write CuciCode keys into Claude Code's own `settings.json` files. Before Phase 1, verify that Claude Code ignores an unknown `cucicode/` folder inside `.claude` and does not validate or rewrite it; if not, report it and propose the closest location inside `.claude`.
- Validate CuciCode's files with a JSON schema; migrate on version changes.
- Every setting in the UI shows its **effective value and where it comes from** (scope + file path), and lets the user choose which scope to write to.
- Secrets (tokens for GitHub/Bitbucket/Linear) go into the OS keychain, never into JSON.

## 3. Layout

- **Left rail:** Projects, Activity, Toolkit, Usage, Concepts, Settings.
- **Projects sidebar:** search, add/new project, each project shows name, branch, clean/dirty, remote host, last activity, a badge if something waits for review.
- **Center:** the project's chat (main thread) with its live timeline.
- **Right inspector (collapsible):** agent tree for the current run, pipeline stage, context meter, changed files, worktrees.
- **Top bar:** current project, global **Inbox** badge ("N waiting for your review" across projects), usage-window indicator.

## 4. Chat with the main thread

- The user talks **directly** to the main thread. No router model in front of it.
- **Mode toggle:** Chat / Brainstorm / Plan. Brainstorm and Plan are one role (see section 6) and switch the model and effort automatically; the user can override.
- Inline **model and effort pickers**, permission mode picker, **stop**, and two ways to send while an agent is running: **Queue** (the message is processed after the current turn) and **Interrupt and send** (stop the turn, then send). The SDK has no mid-turn injection, so there is no true "steer".
- Attachments: images and documents via drag-and-drop, paste and file picker.
- Voice: push-to-talk button and shortcut; transcript lands in the input box for editing before sending.
- **Slash commands, same as in terminal Claude Code.** Typing `/` opens a searchable menu with every available command: built-in ones (e.g. `/clear`, `/compact`, `/model`, `/context`, `/init`, `/agents`, `/mcp`, `/hooks`, `/review`, and the rest of the current built-in list), plus user, project and plugin commands. Each entry shows description, argument hint and source (built-in / user / project / plugin + path).
  - The command list is discovered at runtime from the SDK (`supportedCommands()`, the init message and `commands_changed`), not hardcoded, because it varies by Claude Code version. Known interactive-only built-ins are mapped to native UI as below.
  - Commands that work through the SDK are sent as-is.
  - Interactive built-ins get a native CuciCode equivalent: `/model` opens the model and effort picker, `/agents`, `/mcp` and `/hooks` open the matching Toolkit tab, `/clear` and `/compact` use the context meter actions, `/init` opens the CLAUDE.md generator.
  - Anything without an equivalent opens in the terminal pane with the command pre-filled, so nothing from the terminal is lost.
  - "New command" entry at the bottom of the menu opens the command wizard (Toolkit → Commands), which creates a skill (see section 8).
- **Live timeline** of typed events: user/assistant messages, thinking (if available), tool calls with results, subagent spawned / messages / finished (rendered as nested, collapsible threads so main ↔ subagent conversations are readable), skill invocations, MCP calls (server + tool), hook firings (event, matcher, outcome), permission requests (approve/deny inline), compaction, system/init.
- **Filter chips** to hide/show each category independently; preference saved per project. Collapse repeated identical system events into one line with a counter.
- Every non-message event has an **"Explain"** action (see Learn mode, section 11).
- **Context meter** with Compact and Clear buttons and a one-line explanation of the difference.

## 5. Sessions

- Multiple sessions per project; list with name, date, mode, model, cost estimate.
- Resume, fork, rename, delete, full-text search across sessions.
- Import existing sessions from Claude Code transcripts on disk (including ones started in the terminal). The transcript format is internal and may change, so reading goes through the SDK's session functions (`listSessions`, `getSessionMessages`, `renameSession`, `forkSession`); any direct JSONL access (e.g. delete, full-text search) is isolated behind one adapter.

## 6. Agentic workflow (default, editable)

Roles shipped with CuciCode as a plugin (see section 8), each a normal Claude Code subagent file:

| Role | Default model | Job |
|---|---|---|
| main thread | Sonnet | Conversation and orchestration |
| planner | Opus, high effort | Brainstorm + plan in one role; writes the plan to a file |
| story-writer | Sonnet | Turns the plan into user stories with acceptance criteria and file ownership |
| explorer | Haiku | Read-only codebase exploration and summaries |
| worker | Sonnet | Implements one story, in its own git worktree |
| reviewers: logic, security, ui, code-rules | Sonnet | Review the diff only, after checks pass |

**Pipeline, new project:** Brainstorm → Plan → Stories → Build → Checks → Review → Merge → Done.
**Pipeline, existing project:** Map → Baseline → Scope → Audit → Backlog, then the feature pipeline.
- Each stage is a checkpoint; per project the user chooses which ones need approval. Pending approvals go to the Inbox.
- **Checks before review:** auto-detect the test/build command (overridable); failing checks go back to the worker for up to N auto-fix rounds before any reviewer runs.
- Blocking review findings go back to the worker.
- Hand-off between stages goes through files (plan, stories), so sessions can be cleared between features without losing state. These files live outside `.claude` (which is write-protected for Claude's own tools): stories in `Stories/`, plans in `Plans/` at the project root.
- CuciCode creates each story's worktree itself, at `.claude/worktrees/<story-id>` on branch `story/<story-id>`, and runs one worker session per story there. (An earlier revision used the subagent option `isolation: worktree`; that hides the worktree from the app, which then cannot run checks in it, show its diff or merge it. The worker agent file keeps that option for terminal use.)
- Each pipeline stage is a skill in the CuciCode plugin (`/cucicode:plan`, `/cucicode:stories`, `/cucicode:build`, `/cucicode:fix`, `/cucicode:review`, `/cucicode:onboard`), so the workflow also runs from a terminal.

**Model routing per project:** toggle **Auto** vs **Predefined**. Predefined shows a table role → model → effort.

**Agent reuse:** when enabling a reviewer or explorer, scan existing agents at all scopes and ask: use an existing one (show name, path, description) or create a new one from CuciCode's template.

## 7. Stories

- Default target: `Stories/` folder at the project root. One markdown file per story with frontmatter (id, feature, status, acceptance criteria, owned files, worker, review result). Done stories move to `Stories/archive/`.
- Implement through a `StoriesTarget` interface so a **Linear** target (via the Linear MCP server) can be added later without touching the pipeline.

## 8. Toolkit

- **Toolkit is the single place to see and manage everything Claude Code can use.** Tabs: **Skills, Agents, MCP, Hooks, Commands, Plugins, Output styles, Rules (CLAUDE.md files)**, plus an **All** view. Each tab has a scope filter (All / managed / user / project / local / plugin) and a project selector, so the user can see what exists globally and what a given project actually loads.
- Every item opens a detail panel: full file content (rendered + raw), frontmatter fields, scope, relative and absolute path, which projects use it, last time it was used (linked to the timeline), and edit / duplicate / move-to-scope / delete actions.
- Hooks tab specifics: event, matcher, command or script, scope, timeout, last fired and outcome.
- Agents tab specifics: model, tools allowed, which skills it uses, which pipeline role it fills (if any).
- Scan all scopes: managed, user (`~/.claude/`), project (`.claude/`), project-local, installed plugins. Item types: agents, skills, commands, hooks, MCP servers, output styles, CLAUDE.md/rules files.
- Show for each item: name, type, scope, path relative to its scope root, description, model, and **conflicts** (same name in several scopes, which one wins and why). Watch the filesystem for changes.
- Editors with frontmatter validation; wizards to create a new agent, skill, command or hook.
- **Commands are skills.** Claude Code has merged custom commands into skills: `.claude/commands/*.md` still works, but a skill with the same name wins. The Commands tab lists user-invocable skills together with legacy command files, and the command wizard creates a skill.
- **Shared toolkit:** add a plugin marketplace from a git repo (GitHub or Bitbucket), install/update its plugins per project. This is how skills and agents are shared across all projects.
- CuciCode's own roles, reviewers and Code Rules ship as a CuciCode plugin.

## 8b. Toolkit → MCP tab

- Reachable from Toolkit, from project settings and from `/mcp` in chat.
- List every configured server with: name, scope (user / project `.mcp.json` / project-local / plugin), transport (stdio, HTTP, SSE), status (connected, failed, needs auth), and the tools it exposes.
- **Add server** form: choose the scope to write to, transport, command + args or URL, env vars and headers. Secrets go to the keychain and are referenced, never written in plain text to `.mcp.json` (which may be committed).
- Edit, remove, enable/disable per project, **test connection**, re-authenticate (OAuth) when a server needs it.
- Quick-add presets for common servers (e.g. GitHub, Bitbucket, Linear, Postgres, filesystem, browser), editable before saving.
- Usage per server: which sessions and agents called which tools, linked to the timeline.
- Warn when an MCP server's tool descriptions use a lot of context, with a note on how that affects usage.

## 9. Git

- Hosts: GitHub and Bitbucket (credentials in keychain).
- Per project: push mode (direct to main / PRs only / keep local), merge mode (needs my approval / automatic for low-risk), require CI before merge, max parallel worktrees (default 2), **protected paths** (patterns agents cannot edit, enforced by a hook; e.g. `.env*`, `**/secrets/**`, `**/migrations/**`).
- Worktree view: status, diff, merge, discard.
- Diff viewer per story and per agent; rewind to a checkpoint. Two mechanisms: in chat, the SDK's file rewind (covers Write/Edit only, not Bash or subagent edits, and does not rewind the conversation); in the pipeline, a git commit per stage is the checkpoint.

## 10. New-project wizard

Name, location, stack template, then checkboxes: git init; generate `.gitignore` (always includes `.env*`, secrets, IDE and build output); create remote repo on GitHub/Bitbucket and push; generate CLAUDE.md; install shared toolkit; enable Code Rules; create `Stories/`; start in Brainstorm mode; enable full agentic pipeline; default model routing. Show a summary before executing.

## 11. Conversation style, Code Rules, Learn mode

- **Conversation style:** implemented with Claude Code output styles. "Concise", "Explanatory" and "Learning" are already built into Claude Code, so CuciCode ships none of its own; it switches between them through the native `outputStyle` setting, in settings and in chat. Concise is the default for new projects.
- **Code Rules:** editable list in Settings, stored in the CuciCode plugin. Split into:
  - *Guidance* (rule text loaded as instructions and checked by the code-rules reviewer): no code comments; Javadoc on service classes; no hardcoded values (use config); naming and structure conventions.
  - *Enforcement* (hooks that block): secrets or API keys in source; env values inlined in code; `.env` missing from `.gitignore`; edits to protected paths.
- **Learn mode:** "Explain" on any timeline event gives a short, accurate explanation of what happened and why (what a hook is and which one fired, what this MCP call did, why a subagent was spawned, what compaction did). A **Concepts** page covers: compact vs clear, MCP and how it works, agent vs subagent, skill, hook, Agent SDK vs hooks, custom slash commands, plugins and marketplaces, output styles, worktrees. Content is written once from the docs and linked from events.

## 12. Usage (subscription-aware)

- Focus on the **5-hour window** and **weekly limit**, not money.
- Per session, project, agent, role and model: input/output/cache tokens, from SDK results and transcripts on disk. The result's `usage` field excludes subagents, so totals come from `modelUsage` and per-agent numbers from subagent transcripts.
- Time left in the current window; burn rate; projection ("at this pace the window runs out at 15:40").
- The exact remaining quota is not available as a meter: the SDK only emits `rate_limit_event` (status, utilization, reset time) when the limit state changes. Show that when it arrives, and label every other number as an estimate with an explanation of how it is computed.
- **Budget guardrails** per project: max turns per task, max parallel agents, warning thresholds, optional automatic downgrade of a role's model when near the limit.

## 13. Activity

- Global log across projects (runs, stage changes, approvals, merges, errors), filterable; OS notifications for items that need the user.

## 14. Phases

1. **Foundation:** Tauri shell, sidecar, settings layer with scope resolution, projects sidebar, chat with a single session, live typed timeline with filters, sessions and transcript import, voice input.
2. **Toolkit and settings UI:** full scan, conflicts, editors, wizards, marketplace from git, Toolkit tabs including MCP (sections 8, 8b), slash-command menu with native equivalents (section 4), every Claude Code setting editable at its scope (forms generated from the published settings JSON schema, since there are about 250 keys).
3. **Agentic workflow:** modes, CuciCode plugin roles, pipelines with checkpoints, stories, worktrees, checks, reviewers, model routing, agent reuse prompt, Inbox, Git settings, diff/rewind.
4. **Usage and polish:** usage screens and guardrails, new-project wizard, Code Rules with hooks, output styles, Learn mode and Concepts, Activity, terminal pane.

Each phase ends with: what works, how to demo it, known limits, updated docs. Start with section 0, step 3.

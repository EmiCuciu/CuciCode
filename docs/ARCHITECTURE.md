# CuciCode architecture

CuciCode is a desktop UI for Claude Code. Claude Code does all the work and owns all configuration (`~/.claude`, `<project>/.claude`); CuciCode only shows and edits it. A project configured in CuciCode behaves the same when opened with `claude` in a terminal.

## Processes

```
┌──────────────────────────────────────────────┐
│ React UI (Vite, Tailwind, Zustand)           │  apps/desktop/src
└───────────────▲──────────────────────────────┘
                │ Tauri commands (UI → Rust) and events (Rust → UI)
┌───────────────┴──────────────────────────────┐
│ Rust core (Tauri 2)                          │  apps/desktop/src-tauri
│ settings scopes · fs scan/watch · git ·      │
│ keychain · notifications · pty · whisper ·   │
│ sidecar supervisor                           │
└───────────────▲──────────────────────────────┘
                │ stdio, one JSON object per line
┌───────────────┴──────────────────────────────┐
│ Node sidecar                                 │  sidecar/
│ one SDK query() per open chat                │
└───────────────▲──────────────────────────────┘
                │ @anthropic-ai/claude-agent-sdk
┌───────────────┴──────────────────────────────┐
│ Claude Code binary (bundled with the SDK)    │
│ reads ~/.claude and <project>/.claude        │
└──────────────────────────────────────────────┘
```

Why three processes: the Agent SDK is a Node library, so it needs a Node host (the sidecar). Everything that touches the operating system (files, git, keychain, audio) lives in Rust, where Tauri gives it safe, typed access. The UI holds no privileged logic.

## Repository layout

| Path | Contents |
|---|---|
| `packages/protocol` | The message contract between Rust, sidecar and UI: request schemas (zod), timeline event types, response shapes |
| `sidecar` | Node process that hosts the Agent SDK |
| `apps/desktop/src` | React UI |
| `apps/desktop/src-tauri` | Rust core |
| `plugin/cucicode` | CuciCode's roles, reviewers and Code Rules as a Claude Code plugin (Phase 3) |
| `docs` | This file and `DECISIONS.md` |

## The sidecar protocol

Newline-delimited JSON over the sidecar's stdin/stdout. Defined once in `packages/protocol`.

Rust → sidecar, a request: `{"id": "7", "method": "chat.send", "params": {...}}`

Sidecar → Rust, one of:

| `type` | Meaning |
|---|---|
| `ready` | Sent once at start, with protocol and SDK versions |
| `response` | Answer to a request: `{id, ok, result}` or `{id, ok: false, error}` |
| `event` | A timeline event for one chat: `{chatId, event}` |
| `log` | Diagnostic output; never shown in the timeline |

Methods:

| Method | Purpose |
|---|---|
| `chat.open` | Start or resume a session (`cwd`, `resume`, `model`, `effort`, `permissionMode`) |
| `chat.send` | Send a user message with optional attachments |
| `chat.interrupt` | Stop the current turn |
| `chat.setModel`, `chat.setPermissionMode` | Change a running session |
| `chat.info` | Models, slash commands, subscription type, context usage |
| `chat.close` | End the session |
| `permission.respond` | Answer a permission request (`allow` / `deny`, optionally remember) |
| `sessions.list`, `.messages`, `.rename`, `.delete`, `.fork` | Session management through the SDK's session functions |

Every request is validated against its schema before it runs; an invalid request gets an error response and never reaches the SDK.

## Sidecar internals

| File | Responsibility |
|---|---|
| `main.ts` | Starts up, announces `ready`, feeds stdin lines to the dispatcher |
| `dispatcher.ts` | Validates requests and routes them to handlers |
| `chat.ts` | `ChatSession`: one SDK `query()` in streaming-input mode, fed by a queue |
| `normalize.ts` | Pure function from an SDK message to zero or more timeline events |
| `permissions.ts` | `PermissionBroker`: turns the SDK's `canUseTool` callback into a request event and waits for the UI's answer |
| `sessions.ts` | Wrappers over the SDK's session functions |
| `env.ts` | Builds the environment for Claude Code; removes credential overrides |

### How a chat turn flows

1. The UI calls `chat.send`. The sidecar emits a `user_message` event and pushes the message onto the session's input queue.
2. The SDK consumes the queue and streams messages back. `normalize.ts` converts each one into typed timeline events (`assistant_text`, `tool_call`, `hook`, `subagent`, ...).
3. If Claude Code needs approval for a tool, the SDK calls `canUseTool`. The broker emits `permission_request` and holds a promise open until `permission.respond` arrives.
4. The turn ends with a `result` event carrying per-model token usage.

### Timeline events

Every event has `id`, `ts`, `category` and `parentToolUseId`. The category drives the filter chips; `parentToolUseId` is set for anything that happened inside a subagent, which is how nested threads are built. Tool calls are classified by name: `Agent`/`Task` are subagents, `Skill` is a skill invocation, `mcp__server__tool` is an MCP call. SDK message types the normaliser does not know become `raw` events, so nothing is silently dropped when Claude Code adds a new message type.

## Authentication

CuciCode never handles credentials. The SDK launches its bundled, unmodified Claude Code binary, which reads the login stored by `claude` in `~/.claude`. The sidecar removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` from the environment it passes on, because any of them would take precedence over the subscription login.

## Settings

Claude Code settings are read from and written to Claude Code's own files; CuciCode keeps no copy. Scopes, highest precedence first: managed, command line, project local, project, user. CuciCode's own settings (UI layout, timeline filters, pipeline options) live in `cucicode/settings.json` inside each `.claude` directory, with the same scope convention. Claude Code ignores that folder (verified, see ADR 4).

## Status

| Part | State |
|---|---|
| Protocol package | Done |
| Sidecar | Done, unit-tested, smoke-tested against the real SDK |
| UI | Phase 1: shell, projects sidebar, chat with typed timeline and filter chips, permission prompts, sessions, context meter. Phase 2: Toolkit screen, settings editor, slash-command menu. Logic is unit-tested; screens were checked by launching the app |
| Rust core | Sidecar supervisor, settings resolver and editor, project registry, Toolkit scanner and editor, file watcher, Claude CLI wrapper, keychain secrets. Unit-tested |
| Voice input | Push-to-talk recording and local transcription. Compiles; audio conversion is unit-tested; not yet tried with a microphone |

## Toolkit

The Toolkit answers "what can Claude Code load here, where does each thing live, and which one wins".

| File | Responsibility |
|---|---|
| `toolkit/mod.rs` | `scan(project)`: walks every scope and returns items, installed plugins and marketplaces |
| `toolkit/files.rs` | Markdown items: agents, skills, commands, output styles, rules, `CLAUDE.md` files |
| `toolkit/embedded.rs` | Items that live inside JSON: hooks (settings, plugin `hooks.json`) and MCP servers (`~/.claude.json`, `.mcp.json`, `managed-mcp.json`). Values of env vars and headers are never returned, only their names |
| `toolkit/frontmatter.rs` | Splits a markdown file into YAML frontmatter and body |
| `toolkit/conflicts.rs` | Marks same-named items and says which one Claude Code uses (ADR 13) |
| `toolkit/validate.rs` | Checks frontmatter against the documented fields of each kind |
| `toolkit/edit.rs` | Read, write, create, delete, copy and move, restricted to Claude Code folders |
| `toolkit/plugins.rs` | Reads `installed_plugins.json` and `known_marketplaces.json` |
| `toolkit/watch.rs` | Watches item folders and settings files and tells the UI to rescan |
| `claude_cli.rs` | Runs the `claude` command for MCP servers, plugins and marketplaces (ADR 12) |
| `secrets.rs` | OS keychain storage for values referenced as `${NAME}` (ADR 14) |

Scopes scanned: managed, user (`~/.claude`), project (`.claude`), local (`settings.local.json`, `CLAUDE.local.md`, local MCP servers) and enabled plugins.

In the UI (`features/toolkit`), pure logic is kept apart from components and unit-tested: `templates.ts` (wizard output), `mcp.ts` (server entry and secret references), `hooks.ts` (adding and removing a hook in a settings value), `toolkitStore.ts` (filters). The slash-command menu (`features/chat/slashCommands.ts`) uses Claude Code's own command list once a session runs and the Toolkit scan before that; `/model`, `/agents`, `/mcp`, `/hooks` and `/plugin` open the matching CuciCode screen.

## Agentic workflow

```
 main thread session                         one session per story, in its worktree
 ┌──────────────────────────────┐            ┌────────────────────────────────────────┐
 │ brainstorm → plan → stories  │  approve   │ build → checks → review → merge         │
 │ /cucicode:plan, :stories     │ ─────────► │ /cucicode:build   (CuciCode runs checks)│
 │ writes Plans/, Stories/      │            │ /cucicode:fix on failure, up to N rounds│
 └──────────────────────────────┘            │ /cucicode:review  → RESULT: approved    │
                                             └────────────────────────────────────────┘
```

**The plugin** (`plugin/cucicode`, installable through the marketplace manifest at the repository root):

| Part | Contents |
|---|---|
| `agents/` | `planner` (Opus, high effort), `story-writer`, `explorer` (Haiku, read-only), `worker`, and reviewers for logic, security, UI and code rules |
| `skills/` | One per stage: `brainstorm`, `plan`, `stories`, `build`, `fix`, `review`, `onboard` (map, baseline, scope, audit, backlog for existing projects) |
| `hooks/` | `protect-paths.mjs`: a `PreToolUse` hook that blocks edits to paths listed under `git.protectedPaths` in `.claude/cucicode/settings.json` |

**In the app:**

| File | Responsibility |
|---|---|
| `features/workflow/pipeline.ts` | The engine: a pure `step(run, event, config)` returning the next run and effects (ADR 17) |
| `features/workflow/workflowStore.ts` | The driver: performs effects, listens to session events, saves the run, builds the Inbox |
| `features/workflow/config.ts` | Typed workflow settings with defaults, layered default → project → local |
| `git_ops.rs` | Story worktrees, diff against the merge base, commit, merge (aborted on conflict), push |
| `checks.rs` | Detects check commands from build files and runs them, stopping at the first failure |
| `stories.rs` | Story files behind the `StoriesTarget` trait; the folder target is the only implementation so far |
| `settings/cucicode.rs` | `.claude/cucicode/settings.json` (shared), `settings.local.json` (personal), `pipeline.local.json` (run state) |

A story moves through `queued → building → checks → (fixing) → review → awaiting approval → merging → merged`. After each worker turn CuciCode commits the worktree and runs the checks itself (ADR 19). Finishing a story merges its branch, moves its file to the archive folder, commits that, and removes the worktree.

Checkpoints (after plan, after stories, after checks, after review) are per project; anything waiting, any failed story and any permission request appears in the **Inbox** in the top bar.

The chat's mode toggle maps to the planner role: **Brainstorm** and **Plan** switch to the planner's model and effort, and Plan also uses Claude Code's `plan` permission mode.

## Settings editor

`settings/claude.rs` lists the settings file of each scope (`scope_files`) and sets or removes one key in one of them (`set_value`). The screen (`features/settings`) is generated from the published schema (ADR 15): for each setting it shows the effective value, the value in each scope, and an editor that writes to the scope the user chooses.

## Voice input

`voice/mod.rs` records from the default microphone (`cpal`) while the button or Ctrl+Space is held, converts the audio to mono 16 kHz (`voice/audio.rs`) and transcribes it with whisper.cpp (`whisper-rs`). The transcript is placed in the message box for editing; nothing is sent automatically. The Whisper base model (about 148 MB, multilingual) is downloaded from Hugging Face on first use into the app data directory. No audio leaves the machine.

## Rust core internals

| File | Responsibility |
|---|---|
| `lib.rs` | Registers the Tauri commands; each one is a thin wrapper that runs file and git work off the UI thread |
| `sidecar.rs` | Starts the Node sidecar on first use, matches responses to requests by id, forwards events to the UI, restarts it if it exits |
| `settings/claude.rs` | Reads Claude Code's settings files at every scope and computes each effective value with its source (ADR 10) |
| `settings/cucicode.rs` | Reads and writes CuciCode's own files under `.claude/cucicode/`, preserving keys it does not know and refusing files from a newer version |
| `projects.rs` | Project registry (stored in `~/.claude/cucicode/settings.json`) and git status through the `git` command (ADR 9) |
| `paths.rs` | Claude Code's directories and its project-path encoding |
| `jsonfile.rs` | Tolerant JSON reading and atomic writing |

## UI internals

| Path | Responsibility |
|---|---|
| `bridge/tauri.ts` | The only file that talks to Rust: typed wrappers over Tauri commands and the sidecar event stream |
| `state/timeline.ts` | Pure reducer from timeline events to what the chat shows (streaming draft, merged hook and subagent rows, tool results keyed by call, collapsed repeats, nesting by `parentToolUseId`) |
| `state/store.ts` | Zustand store: projects, one chat per project, sessions, per-project filter preference |
| `features/*` | Components grouped by screen area: `layout`, `projects`, `chat`, `inspector`, `settings` |

A session is opened lazily: viewing an old session only loads its history; the Claude Code process starts (with `resume`) on the first message sent.

## Commands the Rust core provides

| Command | Purpose |
|---|---|
| `sidecar_request(method, params)` | Forward a request to the sidecar and return its response |
| event `sidecar://event` | `{chatId, event}` for every timeline event |
| `projects_list`, `projects_add(path)`, `projects_remove(id)` | Project registry with git branch, clean/dirty, remote host |
| `claude_settings_resolve(projectPath)` | Effective Claude Code settings, each with winning scope and file path |
| `cucicode_project_ui_get/set(projectPath)` | Per-project UI preferences in `.claude/cucicode/settings.local.json` |
| `claude_settings_files`, `claude_settings_set` | Settings file per scope; set or remove one key in a scope |
| `toolkit_scan`, `toolkit_watch`, `toolkit_read/write/create/delete/copy`, `toolkit_validate` | Toolkit listing, change notifications and item editing |
| `mcp_health`, `mcp_add`, `mcp_remove` | MCP servers through the `claude` command |
| `plugin_action`, `marketplace_add/update/remove` | Plugins and marketplaces through the `claude` command |
| `secrets_names`, `secrets_set`, `secrets_delete` | Keychain secrets; values are write-only from the UI |
| `voice_status`, `voice_download_model`, `voice_start`, `voice_stop` | Push-to-talk; `voice_stop` returns the transcript; event `voice://download` reports model download progress |

## Running it

Prerequisites: Node 22 or newer, Rust (stable, MSVC toolchain on Windows), Visual Studio Build Tools with "Desktop development with C++", CMake, and a logged-in `claude` CLI.

```
npm install
npm run dev        # builds the sidecar, starts Vite and the desktop shell
npm test           # sidecar and UI unit tests
npm run typecheck
cd apps/desktop/src-tauri && cargo test
```

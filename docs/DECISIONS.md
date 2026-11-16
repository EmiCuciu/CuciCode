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

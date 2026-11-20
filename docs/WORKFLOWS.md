# CuciCode workflows

This guide explains how the CuciCode plugin and app work together, then walks through 15 end-to-end workflows. Each one says when to use it, what to click, what you should see, and how to keep usage low. It describes the app as built at the end of Phase 4; known gaps are marked **Gap**.

---

## 1. How it works

### 1.1 The three pieces

| Piece | What it is | Where it lives |
|---|---|---|
| **Claude Code** | Does all the work: reads code, edits files, runs commands | The `claude` binary bundled with the Agent SDK |
| **The CuciCode plugin** | A normal Claude Code plugin with the roles (agents), the pipeline stages (skills) and the enforcement hooks | `plugin/cucicode`, installed at user scope |
| **The CuciCode app** | Starts sessions, sends the right stage command at the right time, runs checks, manages git worktrees, waits for your approvals | This desktop app |

The plugin contains:

| Kind | Name | Job | Model in its file |
|---|---|---|---|
| Agent | `cucicode:planner` | Brainstorms and writes `Plans/<feature>.md` | Opus, high effort |
| Agent | `cucicode:story-writer` | Turns a plan into `Stories/S-xxx-*.md` | Sonnet |
| Agent | `cucicode:explorer` | Read-only code exploration | Haiku |
| Agent | `cucicode:worker` | Implements one story | Sonnet |
| Agent | `cucicode:reviewer-logic`, `-security`, `-ui`, `-code-rules` | Review a story's diff and end with `RESULT: approved` or `RESULT: changes_requested` | Sonnet |
| Skill | `/cucicode:brainstorm` `/cucicode:plan` `/cucicode:stories` `/cucicode:build` `/cucicode:fix` `/cucicode:review` `/cucicode:onboard` | One per pipeline stage | — |
| Hook | `protect-paths.mjs`, `code-rules.mjs` | Block edits to protected paths, secrets in code, `.env` values copied into code, unignored `.env` files | — |
| Hook | `inject-delegation.mjs` | On every session start, tells the main session to ask a few short questions and then hand feature work to `cucicode:worker` agents instead of writing code itself; planner, story-writer, tester and reviewers stay opt-in (text in `rules/delegation.md`) | — |

Because the stages are ordinary skills, the whole workflow also runs in a plain terminal (`claude` then `/cucicode:plan …`). The app adds sequencing, approvals, parallel worktrees, checks, diffs and the Inbox.

### 1.2 Hand-off through files

Stages never rely on conversation history. Each stage reads the previous stage's file:

```
/cucicode:brainstorm  →  (conversation only, nothing written)
/cucicode:plan        →  Plans/<feature>.md
/cucicode:stories     →  Stories/S-001-<slug>.md, S-002-…   (status: todo, owned_files, acceptance_criteria)
/cucicode:build       →  code on branch story/S-001, in .claude/worktrees/S-001
/cucicode:review      →  RESULT line + "review:" field in the story
merge                 →  merge commit on your branch, story moved to Stories/archive/
```

So you can **Clear** the chat between stages or features without losing anything, which is the single biggest usage saver.

### 1.3 A new feature, step by step

```
You: Start feature ──► brainstorm (optional) ──► plan ──[approve]──► stories ──[approve]──► build
                                                                                          │
   per story, in its own worktree and session:                                            ▼
   build ──► CuciCode commits + runs checks ──fail──► fix (max N rounds) ──► checks again
                              │pass
                              ▼
                       [approve checks]* ──► review (3–4 reviewers) ──changes──► fix ──► checks ──► review
                                                     │approved
                                                     ▼
                                       [approve merge] ──► merge, archive story, remove worktree
* off by default
```

- Stories with `depends_on` wait until the stories they depend on are merged.
- At most **2** stories build at the same time by default.
- CuciCode runs the checks itself and reads the exit codes. A worker cannot pass by claiming success, and reviewers never see code that fails its checks.

### 1.4 An existing project

An existing codebase first goes through **onboarding**: map → baseline → scope → audit → backlog. Each stage writes one file in `Plans/onboarding/` and always waits for your approval, because each stage's output is what the next one trusts. After that, you add features exactly as in 1.3.

### 1.5 Where usage goes

| Step | Who runs | Model with default settings | Tokens? |
|---|---|---|---|
| Brainstorm, plan | planner subagent | Opus, high effort | High |
| Stories | story-writer subagent | Sonnet | Low–medium |
| Build, fix | worker session | **Auto routing: your Claude Code default model.** Predefined: Sonnet | Medium–high |
| Checks | your test/build commands, run locally | — | **None** |
| Review | 3 reviewers (+1 if UI files changed), started from the worker session | Sonnet | Medium |
| Merge, archive, worktrees, diffs | CuciCode and git | — | **None** |
| Explain, Concepts, Usage screen | CuciCode | — | **None** |

> **Watch out:** in **Auto** routing the main thread and every worker use your Claude Code default model (whatever `/model` last saved, which may be Opus). For minimal usage, switch to **Predefined** routing (workflow 3).

---

## 2. Screens you will use

| Where | What is there |
|---|---|
| **Left rail** | Projects, Activity, Toolkit, Usage, Concepts, Settings |
| **Projects sidebar** | Search, **+** (add an existing folder), **New** (new-project wizard) |
| **Centre** | Chat. Above it, when stories run: tabs `main thread`, `S-001`, `diff`. Below it, the optional terminal |
| **Message box** | Mode **Chat / Brainstorm / Plan**, model, effort, permission mode, style, Attach, Hold to talk, Terminal, Send (or Stop / Interrupt and send / Queue while running) |
| **Right panel** | **Pipeline** (start, approve, story list), **Worktrees**, **Context** (Compact, Clear), **Last turn** tokens, **Sessions** |
| **Top bar** | **Inbox** (everything waiting for you), **5h window** indicator, theme |
| **Settings → Workflow (CuciCode)** | Plugin install, checkpoints, roles and routing, checks, git, Code Rules, budget, stories folder |
| **Settings → Claude Code settings** | Every Claude Code setting, its value per scope and where it comes from |

---

## 3. Settings reference

### 3.1 Workflow settings (Settings → Workflow (CuciCode))

At the top you choose where changes go: **project** (`.claude/cucicode/settings.json`, shared with the team) or **local** (`settings.local.json`, only you). Local wins over project.

| Card | Setting | Default | What it changes |
|---|---|---|---|
| CuciCode plugin | Install | not installed | Without it there are no roles, stages or enforcement hooks |
| Checkpoints | After the plan | on | Pipeline waits for **Approve plan** |
| | After stories | on | Waits for **Approve stories and build** |
| | After checks pass | off | Each story waits for **Start review** |
| | After review | on | Each story waits for **Approve and merge** |
| | Automatic fix rounds | 2 | How many times failing checks or blocking review findings go back to the worker before the story stops |
| Roles and routing | Auto / Predefined | Auto | Auto overrides nothing. Predefined: main thread and workers start with the table's model and effort; for subagent roles the table edits the agent's own file |
| | Agent per role | CuciCode's agents | Pick one of your own agents for a role, or **create my own from this template** to copy CuciCode's into `.claude/agents/` |
| Checks | Commands | auto-detected | e.g. `npm run lint`, `npm run test`, `cargo test`; one per line. They run in the story's worktree and stop at the first failure |
| Git | After a merge | keep it local | **push the branch to origin**, or **push the story branch and open a pull request** (no local merge) |
| | Merging a reviewed story | needs my approval | **automatic when review approves** (only if "After review" is also off) |
| | Stories built at the same time | 2 | Parallel worktrees, 1–8 |
| | Token | none | GitHub or Bitbucket token for pull requests and repository creation; kept in the OS keychain, never given to agents |
| | Protected paths | `.env*`, `**/secrets/**`, `**/migrations/**` | Agents cannot edit matching files, in the app or the terminal |
| Code Rules | Guidance | none until created | Bullet rules in `.claude/rules/cucicode-code-rules.md`, loaded in every session and checked by the code-rules reviewer |
| | Enforcement | all on | Block secrets in source, `.env` values in code, `.env` not ignored by git |
| Budget guardrails | Most turns per worker task | 0 (no limit) | Stops a runaway worker turn |
| | Warn at | 80% | Colour of the usage indicators |
| | Downgrade workers near the limit | off, 90%, haiku | New worker sessions start on the cheaper model when the 5-hour window is past the threshold |
| Stories | Folder | `Stories` | Where story files live |

### 3.2 Claude Code settings (Settings → Claude Code settings)

Every setting from the published schema. For each one you see the effective value, the value in each scope, and you choose which file to write: **local** (`.claude/settings.local.json`), **project** (`.claude/settings.json`) or **user** (`~/.claude/settings.json`). The useful ones for cost are `model`, `effortLevel` and `outputStyle`.

### 3.3 Files CuciCode creates in a project

| File or folder | Committed? | Purpose |
|---|---|---|
| `Plans/<feature>.md`, `Plans/onboarding/*.md` | yes | Plans and onboarding results |
| `Stories/S-xxx-*.md`, `Stories/archive/` | yes | Stories; finished ones are archived |
| `.claude/cucicode/settings.json` | yes | Workflow settings for the team |
| `.claude/cucicode/settings.local.json`, `pipeline.local.json` | no (git-ignored) | Your overrides; the current pipeline run |
| `.claude/rules/cucicode-code-rules.md` | yes | Code Rules guidance |
| `.claude/worktrees/<story>` | no (local exclude) | One working folder per story, on branch `story/<id>` |
| `~/.claude/cucicode/activity.local.jsonl` | n/a | Activity log |

---

## 4. Workflows

Each workflow lists: **Use when**, **Steps**, **Expected output**, and **Keep it cheap**.

---

### Workflow 1 — First-time setup

**Use when:** you just installed CuciCode.

**Steps**
1. Make sure `claude` works in a terminal and you are logged in.
2. Run `npm run dev` in the CuciCode folder.
3. **Projects → +** and pick a project folder (or use workflow 2 for a new one).
4. **Settings → Workflow (CuciCode) → Install the CuciCode plugin.**
5. Still on that page, set **Roles and model routing → Predefined** if you care about usage (see 1.5).
6. Open **Usage** once to see your current 5-hour and weekly figures.

**Expected output**
- The project shows in the sidebar with branch, clean/dirty and remote host.
- The plugin card says *Installed and enabled*; the routing table no longer shows "Not found".
- In **Toolkit → Agents** you see eight `cucicode:` agents. Typing `/` in the chat lists `/cucicode:plan` and the other stages.

**Keep it cheap:** nothing here uses tokens.

---

### Workflow 2 — New project from scratch, full pipeline

**Use when:** you are starting something new and want the plan → stories → build flow from day one.

**Steps**
1. **Projects → New.**
2. Fill in the name, location and stack (Empty, Node.js, Python or Rust). Leave the defaults on: git init, .gitignore, CLAUDE.md, Code Rules, Stories/, full pipeline, Start in Brainstorm mode. Add a remote and shared plugins if you want them.
3. **Review**: read the numbered summary. Nothing has been created yet.
4. **Create the project**: watch each step turn `done`.
5. In the right panel, **Pipeline**: type a feature name (short and kebab-friendly, e.g. `user login`) and what it should do. Click **Start feature**.
6. **Brainstorm:** the planner proposes 2–3 approaches and asks questions. Answer them in the chat. When you agree, click **Write the plan**.
7. The Inbox shows *Plan for "user-login" is ready for review*. Open `Plans/user-login.md`. Then **Approve plan**, or **Request changes** and describe what to change.
8. The story writer creates the stories. Read them in `Stories/`, then **Approve stories and build**.
9. Story tabs appear above the chat. Watch `S-001` build; its **diff** tab shows the changes and the check results.
10. When a story says **ready to merge**, open its diff and click **Approve and merge**.
11. When every story is merged, the pipeline says **done**. Click **Close and start another feature**.

**Expected output**
- Folder with starter files, `.gitignore` (with `.env*` ignored and `.env.example` allowed), `CLAUDE.md`, `Stories/`, `Plans/`, `.claude/settings.json` with `"outputStyle": "Concise"`, `.claude/cucicode/settings.json`, and a first commit on `main`.
- `Plans/user-login.md` with Goal, Out of scope, Approach, Changes, Risks, Checks and Slices.
- `Stories/S-001-….md` and more, each with `status: todo`, acceptance criteria and owned files.
- One merge commit per story (`Merge story S-001`), each story moved to `Stories/archive/` with `status: done`, and no worktrees left.
- **Activity** lists every stage, approval and merge.

**Keep it cheap:** this is the most expensive workflow. Brainstorm and plan run on Opus with high effort. Workflow 3 is the cheap version.

---

### Workflow 3 — New project or feature, minimal usage

**Use when:** you want the pipeline's safety (plan, stories, checks, review) but your weekly limit matters.

**Steps**
1. **Settings → Workflow (CuciCode)**, write to **local** if this is only your preference:
   - **Routing: Predefined.** Main thread `sonnet`; worker `sonnet`.
   - Planner row: set model `sonnet`, effort `medium`. CuciCode copies the planner into `.claude/agents/planner.md` and points the role at it.
   - Reviewer rows: set model `haiku` for logic and code rules, and keep security on `sonnet`.
   - **Stories built at the same time: 1**, so usage is spread out and you can stop between stories.
   - **Automatic fix rounds: 1.**
   - **Budget guardrails:** most turns per worker task `40`; tick **Near the limit, start workers on a cheaper model** at `85` % → `haiku`.
2. **Checks:** make sure they are fast (unit tests and lint, not a 10-minute build). Checks cost no tokens, but every failure costs a fix round.
3. Start the feature with **skip brainstorm, go straight to the plan** ticked, and describe the feature precisely in "What should it do?".
4. Ask for **small** stories: when you approve the plan, reject it if the Slices section has more than 3–5 items for a small feature.
5. After each story merges, click **Clear** in the Context card before the next feature.

**Expected output**
- The same files as workflow 2. The routing table shows your choices, and `.claude/agents/` holds your copies of the planner and reviewers.
- In **Usage → By model**, Opus disappears from new work; most tokens show under Sonnet and Haiku.
- A note in the pipeline panel if a worker was downgraded near the limit.

**Keep it cheap, further:** for a change under about 50 lines, skip the pipeline and use workflow 6.

---

### Workflow 4 — Bring an existing project into CuciCode (onboarding)

**Use when:** the codebase existed before CuciCode and agents have never seen it.

**Steps**
1. **+** to add the folder. The project must be a git repository with at least one commit.
2. Install the plugin (workflow 1). Set **Checks** to the project's real test command if auto-detection shows "none detected".
3. Set **Protected paths** for anything agents must never touch (migrations, deployment config, generated code).
4. **Pipeline → Onboard this project.**
5. **map:** an explorer describes the project. Read `Plans/onboarding/map.md`, then **Approve and continue** (or **Request changes**: "the payments module is missing").
6. **baseline:** it runs the tests and build and records what passes today without fixing anything. Approve.
7. **scope:** it asks you which areas agents may work on. Answer in the chat. It writes `scope.md`, including suggested protected paths. Copy any you agree with into Settings → Git.
8. **audit:** it lists problems inside the scope, with evidence. Approve.
9. **backlog:** it turns the audit items you approve into stories. **Approve and finish.**

**Expected output**
- `Plans/onboarding/map.md`, `baseline.md`, `scope.md`, `audit.md`, and new story files in `Stories/`.
- The pipeline shows `done`. The Inbox showed one item per stage while it waited.

**Gap:** there is no "build these existing stories" button. To build backlog stories, either:
- type `/cucicode:build S-004` in the chat. The worker agent then works in a Claude Code worktree; review and merge it yourself (workflow 6's review step), or
- start a feature (workflow 5) whose description says "implement backlog stories S-004 to S-006", so the planner and story writer produce stories the pipeline can drive.

**Keep it cheap:** onboarding mostly reads code with Haiku explorers. For a large repository, narrow the scope early (step 7) so the audit does not read everything.

---

### Workflow 5 — Add a feature to an existing project

**Use when:** the project is onboarded (or you know it well) and you want a reviewed, merged feature.

**Steps**
1. **Commit or stash your own work first.** Worktrees only contain committed files, and a merge refuses to run if your main folder has uncommitted changes to tracked files.
2. **Pipeline:** feature name, a precise description, usually tick **skip brainstorm**. Start.
3. Approve the plan and stories as in workflow 2, checking two things:
   - each story's `owned_files` stays inside the area you agreed in `scope.md`;
   - no two stories own the same file. The story writer reports overlaps; send it back if there are any.
4. While stories build, keep working in the **main thread** tab if you like. It is a separate session.
5. Approve and merge each story.

**Expected output**
- Branches `story/S-0xx` appear and disappear. `git log` shows a merge commit per story and an archive commit per story.
- The **Worktrees** card lists active stories with commits ahead, changed files and clean/uncommitted.
- With push mode **push the branch to origin**, each merge is pushed.

**Keep it cheap:** same knobs as workflow 3. Writing a precise description and skipping brainstorm saves the most.

---

### Workflow 6 — Small change or bug fix, no pipeline (cheapest)

**Use when:** a fix, a rename, a test, a small UI tweak, anything you would review in one sitting.

**Steps**
1. In the chat, keep **Chat** mode. Pick model **sonnet** (or haiku for trivial edits) and effort **low** or **medium**.
2. Permission mode **default**: you approve each edit inline. Use **acceptEdits** to let it edit without asking; protected paths and Code Rules still block.
3. Describe the change and point at files (attach a screenshot or log if useful).
4. If it goes wrong, hover your message → **rewind files to here…** → **Restore files**.
5. Optional review without the pipeline: work on a branch (not `main`), commit, then type `/cucicode:review` followed by a short description. The review skill reviews the commits that are on your branch but not on the default branch, so on `main` itself it finds nothing to review.
6. **Clear** when done.

**Expected output**
- Tool calls, edits and permission cards in the timeline; **Last turn** shows the tokens used.
- Your working folder contains the change. Nothing is committed unless you or Claude commit it.

**Keep it cheap:** this uses one session, no planner and no reviewers unless you ask. Prefer it whenever the change does not need a plan.

---

### Workflow 7 — Plan without changing anything

**Use when:** you want to understand the cost and shape of a change before committing to it, or you want a plan to discuss with your team.

**Steps**
1. Switch the message box to **Plan** mode. This uses the planner's model and Claude Code's `plan` permission mode, so it can read but not edit.
2. Ask: "How would we add X? List the files, the risks and a step-by-step plan."
3. If you like it, either keep it as a reference or start a pipeline feature and paste the key decisions into "What should it do?".
4. Switch back to **Chat**.

**Expected output**
- A written plan in the chat and **no file changes**. Edit attempts are refused by Claude Code itself.

**Keep it cheap:** Plan mode uses the planner's model (Opus by default). For a cheap plan, set the planner to Sonnet first (workflow 3, step 1).

---

### Workflow 8 — A story fails or gets stuck

**Use when:** a story row says **failed**, or the Inbox says `S-00x failed: …`.

**What failed, and what to do**

| Message | Meaning | What to do |
|---|---|---|
| `checks failed after N fix round(s)` | The worker could not make the checks pass | Open **diff**, read the failing output in **Checks**. Fix it yourself in the worktree or the main thread, then **Retry**. Or rewind (below) |
| `review requested changes …` and the fix limit reached | Reviewers kept finding blocking problems | Read the review in the story tab. Fix or relax the rule, then **Retry** |
| `the review ended without a RESULT line` | The reviewer report had no verdict | **Retry**; usually transient |
| `the usage limit was reached …` | Your 5-hour window ran out mid-turn | Wait for the reset (top bar shows when), then **Retry** |
| `… conflict … The merge was aborted` | The story conflicts with your branch | Open the story's worktree (`.claude/worktrees/S-00x`), merge your branch into it and resolve, commit, then **Approve and merge** again |

**Undo a story's work**
- **diff → Checkpoints → rewind to here** on an earlier commit, then **discard everything after this**. CuciCode commits the worktree after every worker turn, so each turn is a checkpoint.
- Or **Worktrees → discard → discard for good**. This deletes the folder and the `story/` branch.

**Expected output**
- After **Retry**: the story goes back to `building` with its fix rounds reset.
- After a rewind: the checkpoint list ends at the chosen commit and the diff shrinks.

**Keep it cheap:** reading the check output yourself and fixing a one-liner is far cheaper than letting another fix round run.

---

### Workflow 9 — Say no at a checkpoint

**Use when:** the plan, the stories or a finished story is not what you want.

**Steps**
- **Plan or stories:** **Request changes**, write what to change ("split the database migration into its own story"), then **Send back**. The planner or story writer revises the same files, and you get the checkpoint again.
- **A story ready to merge:** **View diff** first. Then **Request changes** with the reason. It goes back to the worker as a fix, then through checks and review again.
- **A stage that stopped** (for example you pressed Stop): the panel shows *This stage stopped before finishing* → **Run it again**.
- **Give up on the run:** **Abandon this run**. Plans, stories and worktrees stay on disk.

**Expected output**
- The run log (expand **log** in the Pipeline card) records "Plan sent back for changes." and similar lines; so does **Activity**.

**Keep it cheap:** precise rejection reasons avoid a second round.

---

### Workflow 10 — Share the setup with your team

**Use when:** colleagues should get the same roles, rules and plugins when they open the repository, in CuciCode or in a terminal.

**Steps**
1. **Settings → Workflow (CuciCode)** with **project** selected: set checkpoints, checks, protected paths and routing mode. These go to `.claude/cucicode/settings.json`.
2. **Code Rules:** create the rules file and add your team's rules.
3. **Toolkit → Plugins → Add marketplace** with your team's git repository (GitHub `owner/repo` or any git URL, Bitbucket included), scope **project**. Install the plugins your team uses to **project**.
4. Agents or skills that only this repository needs: **Toolkit → New** → scope **project**.
5. Commit `.claude/settings.json`, `.claude/cucicode/settings.json`, `.claude/rules/`, `.claude/agents/`, `.claude/skills/`, `Plans/` and `Stories/`.

**Expected output**
- A colleague who opens the repository gets the same rules and, after trusting the project, the same plugins.
- Personal choices stay out of git: `settings.local.json` files are ignored.

**Note:** the CuciCode plugin itself is installed per person (user scope), from CuciCode's own repository.

---

### Workflow 11 — Connect an MCP server with a secret

**Use when:** agents should reach GitHub, a database, Linear, a browser or similar.

**Steps**
1. **Toolkit → MCP → Add server**, choose a preset (or fill it in yourself) and check the command or URL against the server's own docs.
2. Choose the scope: **local** (only you, this project), **project** (`.mcp.json`, usually committed) or **user** (all your projects).
3. For tokens, tick **secret** next to the value. The preview shows `${NAME}` instead of the value.
4. **Add server**, then **Test connections**.

**Expected output**
- The server appears with `connected`, `needs auth` or `failed`.
- The config file contains `${GITHUB_AUTHORIZATION}` (or similar), never the token. The value is in the OS keychain and CuciCode injects it into the sessions it starts.
- MCP calls show in the timeline as `mcp <server>`.

**Keep it cheap:** every server adds tool definitions to context. Add only the servers a project needs, and prefer **local** scope over user scope.

**Note:** in a terminal, set the same environment variable yourself; the keychain value is only given to sessions CuciCode starts.

---

### Workflow 12 — Pull requests instead of local merges

**Use when:** your team merges through GitHub or Bitbucket.

**Steps**
1. Create an access token on the host with repository and pull-request rights.
2. **Settings → Workflow → Git:** check the **Remote** line, paste the token and **Save token**.
3. **After a merge → push the story branch and open a pull request.**
4. Run a feature as usual. **Approve and merge** now pushes `story/S-00x` and opens the PR.

**Expected output**
- A notice and Activity entry with the PR link. The story counts as merged in the pipeline and its worktree is removed; nothing is merged locally.

**Gap:** a story that depends on a story sent as a PR starts from your branch without that PR's changes until you merge the PR on the host. Order dependent stories so they are merged first, or merge the PR before approving the next story. This path has not been tested against a live host yet; try it on a throwaway repository.

---

### Workflow 13 — Watch usage and adapt

**Use when:** before starting a pipeline run, and whenever the top-bar indicator turns yellow or red.

**Steps**
1. Glance at the top bar: `5h window 64% · resets 15:00`, or in red `runs out ~13:20` if the current pace would exhaust the window before it resets.
2. **Usage** for the details: both meters, then **By model / role / agent / project / session** for the last 5 hours, 24 hours or 7 days.
3. Find the expensive part. For example, **By role** shows *Planner* far ahead: lower its model (workflow 3).
4. If you are near the limit: set **Stories built at the same time: 1**, enable the downgrade, or pause by not approving the next checkpoint. Approvals are free and the run waits.

**Expected output**
- Meters labelled with when Claude Code last fetched them. A window whose reset time has passed is shown grey ("reset since last check").
- Token tables counted from session transcripts on this machine; "cache read" is shown separately because it counts far less than fresh input.

**Keep it cheap:** the run-out time is an estimate based on the average pace so far. Treat it as a warning, not a promise.

---

### Workflow 14 — Use your own agent for a role

**Use when:** you already have a reviewer or explorer you trust, or want a stricter one.

**Steps**
1. **Settings → Workflow → Roles and model routing.** In the role's **agent** column, pick one of your agents. The list shows each agent's scope and file, and hides agents that another one with the same name overrides.
2. Or keep CuciCode's agent and click **create my own from this template**. It is copied to `.claude/agents/<name>.md` and the role points at the copy. Edit it in **Toolkit → Agents** (the editor validates the frontmatter as you type).

**Expected output**
- The prompts the pipeline sends name your agent ("Use the `my-reviewer` agent instead of `cucicode:reviewer-logic`").
- Toolkit shows your copy as the one that **wins** if names collide.

---

### Workflow 15 — Learn while you work, and fall back to the terminal

**Use when:** you want to know what just happened, or need a Claude Code screen the app does not replace.

**Steps**
- Under any tool call, hook, subagent, compaction or permission row, click **explain** for a short explanation of that exact event, with a link to the matching **Concepts** page. This costs nothing.
- **Concepts** in the left rail covers context, compact vs clear, agents and subagents, skills, slash commands, hooks, SDK vs hooks, MCP, permissions, plugins, output styles, worktrees and settings scopes.
- Type `/` and pick a command marked **built-in · terminal**: the **Terminal** pane opens running `claude '/command'`. Or click **Terminal** under the message box for a plain shell in the project folder.

**Expected output**
- An explanation such as "The hook `protect-paths` ran on PreToolUse … It exited with code 2, which blocks the action and shows its message to the model."
- A real shell in the pane. Its Claude Code session is separate from the chat's.

---

## 5. Cheat sheet: minimal-usage defaults

| Setting | Minimal-usage value |
|---|---|
| Routing | Predefined; main thread and worker `sonnet` |
| Planner | `sonnet`, effort `medium` (copy created automatically) |
| Reviewers | logic and code rules on `haiku`, security on `sonnet` |
| Stories built at the same time | 1 |
| Automatic fix rounds | 1 |
| Most turns per worker task | 40 |
| Downgrade near the limit | on, 85 %, `haiku` |
| Brainstorm | skip unless the idea is unclear |
| Checks | fast and reliable; flaky checks burn fix rounds |
| Between features | **Clear**, not Compact |
| Small changes | workflow 6, not the pipeline |
| Output style | Concise (the default for new projects) |

## 6. Known gaps (as of Phase 4)

- No button to build stories that already exist (from onboarding or written by hand); see workflow 4.
- One pipeline run per project at a time, and the pipeline only advances while the app is open.
- Pull requests and remote repository creation are untested against a live host.
- "Require CI before merge" is stored but not enforced.
- Worker sessions do not see `settings.local.json`, because worktrees contain only committed files.
- The terminal pane starts its own Claude Code session; it does not continue the chat's session.

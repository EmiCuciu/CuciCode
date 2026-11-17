export interface Concept {
  id: string;
  title: string;
  summary: string;
  body: string[];
  inCuciCode: string;
  docs: string;
}

/**
 * Written once from the Claude Code documentation (code.claude.com/docs), checked against
 * Claude Code 2.1.325. Each "Explain" on a timeline event links to one of these.
 */
export const CONCEPTS: Concept[] = [
  {
    id: 'context',
    title: 'Context window',
    summary: 'Everything the model sees in one request: system prompt, tools, CLAUDE.md, the conversation so far and tool results.',
    body: [
      'Every turn sends the whole conversation again. Long tool outputs, many MCP tool definitions and big files read into the chat all take space.',
      'When the window fills up, older parts must be summarised (compaction) or dropped (clear). Prompt caching makes re-sent context much cheaper, which is why "cache read" tokens count far less against your limits than fresh input.',
    ],
    inCuciCode: 'The context meter in the right panel shows how full the window is, read from Claude Code after each turn.',
    docs: 'https://code.claude.com/docs/en/costs',
  },
  {
    id: 'compact-vs-clear',
    title: 'Compact vs clear',
    summary: 'Compact summarises the conversation and keeps going; clear starts again with an empty conversation.',
    body: [
      '/compact asks the model to write a summary of the conversation so far, then continues with that summary in place of the full history. You keep the thread of the work but lose detail. Claude Code also compacts automatically when the window is nearly full.',
      '/clear drops the conversation entirely. CLAUDE.md, rules and settings are loaded again as at the start of a session, so nothing configured is lost.',
      'Clear is the cheaper habit between unrelated tasks. Compact is for staying in one long task.',
    ],
    inCuciCode: 'The Compact and Clear buttons send the same commands. The pipeline hands work over through files (Plans/, Stories/), so you can clear between features without losing anything.',
    docs: 'https://code.claude.com/docs/en/commands',
  },
  {
    id: 'subagent',
    title: 'Agent vs subagent',
    summary: 'The main conversation is the agent you talk to; a subagent is a separate model run it delegates a task to, with its own context.',
    body: [
      'A subagent is defined by a markdown file (in .claude/agents/, ~/.claude/agents/ or a plugin) with a description, a prompt, and optionally its own tools, model and permission mode.',
      'The main agent starts one through the Agent tool when a task matches the subagent\'s description. The subagent works in a fresh context and returns only its final report, so the main conversation stays small.',
      'Subagents can run in parallel and can be nested up to three levels by default.',
    ],
    inCuciCode: 'Subagent runs appear as nested threads in the timeline. The pipeline roles (planner, story writer, explorer, reviewers) are subagents from the CuciCode plugin.',
    docs: 'https://code.claude.com/docs/en/sub-agents',
  },
  {
    id: 'skill',
    title: 'Skill',
    summary: 'A folder with a SKILL.md: instructions (and optionally scripts) that Claude loads only when they are relevant, or that you run as /name.',
    body: [
      'Only the skill\'s name and description are in context until it is used, which keeps context small. When Claude decides it applies, or you type /name, the full instructions are loaded.',
      'disable-model-invocation: true makes a skill run only when you type it, which is how custom slash commands are written today.',
      'context: fork runs the skill in a subagent instead of the main conversation.',
    ],
    inCuciCode: 'Skill invocations show in the timeline with the skill name. Each pipeline stage is a skill: /cucicode:plan, /cucicode:build and so on.',
    docs: 'https://code.claude.com/docs/en/skills',
  },
  {
    id: 'slash-commands',
    title: 'Custom slash commands',
    summary: 'A prompt saved under a name and run with /name. Claude Code has merged them into skills.',
    body: [
      'Old-style command files in .claude/commands/*.md still work. A skill with the same name takes precedence.',
      '$ARGUMENTS in the file is replaced with what you type after the command; argument-hint shows what to type in the / menu.',
      'Built-in commands such as /compact or /clear are part of Claude Code; some open interactive screens in the terminal and cannot run inside the SDK.',
    ],
    inCuciCode: 'Typing / in the chat lists every command with its source. Built-ins that are terminal screens (/model, /mcp, /hooks, /agents, /plugin) open the matching CuciCode screen instead.',
    docs: 'https://code.claude.com/docs/en/slash-commands',
  },
  {
    id: 'hook',
    title: 'Hook',
    summary: 'A command Claude Code runs by itself at a fixed moment, such as before a tool runs. Unlike instructions, it always runs.',
    body: [
      'Hooks are defined in settings files or plugins, per event (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart and others) and optionally a matcher such as a tool name.',
      'The hook receives the event as JSON on stdin. For events that can block, exit code 2 stops the action and its stderr is shown to the model as the reason; JSON output can allow, deny or modify instead.',
      'Because they are code, hooks are the right place for rules that must hold: blocking edits to certain files, or running a formatter after every edit.',
    ],
    inCuciCode: 'Hook runs appear in the timeline with event, name and outcome. Protected paths and Code Rules enforcement are hooks in the CuciCode plugin.',
    docs: 'https://code.claude.com/docs/en/hooks',
  },
  {
    id: 'sdk-vs-hooks',
    title: 'Agent SDK vs hooks',
    summary: 'The SDK is how a program drives Claude Code; hooks are how Claude Code calls out to your code while it runs.',
    body: [
      'The Agent SDK starts a Claude Code session from your program, sends messages into it, receives every event, answers permission questions and can change the model or permission mode while it runs.',
      'Hooks are configured in files and run as separate commands. They work the same whether Claude Code was started from the SDK, the terminal or an IDE.',
      'A rule that must also hold in the terminal belongs in a hook; behaviour that only matters inside one app belongs in that app\'s SDK code.',
    ],
    inCuciCode: 'CuciCode drives Claude Code through the SDK (the Node sidecar). Its rules that must also apply in the terminal are hooks in the CuciCode plugin.',
    docs: 'https://code.claude.com/docs/en/agent-sdk/overview',
  },
  {
    id: 'mcp',
    title: 'MCP',
    summary: 'The Model Context Protocol connects Claude Code to external tools and data through servers that each expose a set of tools.',
    body: [
      'An MCP server is either a program Claude Code starts locally (stdio) or a remote service it connects to (http). Each tool it exposes appears to the model as mcp__server__tool.',
      'Servers are configured per scope: local and user in ~/.claude.json, project in .mcp.json (often committed), or by plugins. The same name at a narrower scope wins.',
      'Tool definitions take context space. Claude Code loads them on demand (tool search) by default, but a server with many tools still adds up.',
    ],
    inCuciCode: 'MCP calls appear in the timeline with server and tool. Toolkit → MCP adds, tests and removes servers; secrets go to the OS keychain and the config holds ${NAME}.',
    docs: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'permissions',
    title: 'Permissions',
    summary: 'Rules and a mode that decide whether a tool call runs, asks you first or is refused.',
    body: [
      'Allow, ask and deny rules (for example Bash(npm test:*)) live in settings files. The permission mode sets the default: default asks for edits and commands, acceptEdits allows file edits, plan allows only reading, and bypassPermissions allows everything.',
      'Hooks run regardless of the mode, so a blocking hook still applies when permissions are bypassed.',
    ],
    inCuciCode: 'Permission requests appear in the timeline with Allow and Deny, and in the Inbox. Workers get only their check commands and basic git on top of acceptEdits.',
    docs: 'https://code.claude.com/docs/en/permissions',
  },
  {
    id: 'plugins',
    title: 'Plugins and marketplaces',
    summary: 'A plugin bundles agents, skills, commands, hooks, MCP servers and output styles; a marketplace is a git repository that lists plugins.',
    body: [
      'Plugins are installed per scope (user, project or local) and recorded in settings, so a project can declare which plugins its team uses.',
      'A marketplace can be any git repository with a .claude-plugin/marketplace.json, on GitHub, Bitbucket or elsewhere. Adding your team\'s repository is how shared agents and skills reach every project.',
      'Plugin items are namespaced (plugin:name), so they never clash with your own.',
    ],
    inCuciCode: 'Toolkit → Plugins adds marketplaces and installs plugins through the claude command. CuciCode\'s own roles ship as the cucicode plugin.',
    docs: 'https://code.claude.com/docs/en/plugins',
  },
  {
    id: 'output-styles',
    title: 'Output styles',
    summary: 'Replace how Claude writes its answers (tone, length, structure) without changing what it can do.',
    body: [
      'Built-in styles include Concise, Explanatory, Learning and Proactive; custom styles are markdown files in output-styles/ folders or plugins.',
      'The active style is the outputStyle setting. /output-style saves it to the project\'s .claude/settings.local.json, and it applies from the next message.',
    ],
    inCuciCode: 'The style picker under the message box uses the same mechanism, so the terminal sees the same style.',
    docs: 'https://code.claude.com/docs/en/output-styles',
  },
  {
    id: 'worktrees',
    title: 'Git worktrees',
    summary: 'A second working folder for the same repository, on its own branch, so two pieces of work never touch each other\'s files.',
    body: [
      'git worktree add creates a folder with its own checkout. Commits made there are on its branch and are visible from the main folder without copying anything.',
      'Claude Code uses .claude/worktrees/ for its own worktrees (claude --worktree, and subagents with isolation: worktree).',
      'A worktree only contains what is committed, so uncommitted files in the main folder are not there.',
    ],
    inCuciCode: 'Each story is built in .claude/worktrees/<story-id> on branch story/<story-id>, so stories can run in parallel and be diffed, merged or discarded cleanly.',
    docs: 'https://code.claude.com/docs/en/worktrees',
  },
  {
    id: 'settings-scopes',
    title: 'Settings scopes',
    summary: 'Claude Code reads settings from several files; a narrower scope overrides a broader one, and lists are combined.',
    body: [
      'From highest to lowest: managed (set by your organisation), command line, project local (.claude/settings.local.json, personal), project (.claude/settings.json, shared) and user (~/.claude/settings.json).',
      'A single value such as model is taken from the highest scope that sets it. Lists such as permissions.allow are combined across scopes.',
    ],
    inCuciCode: 'Settings shows each value with the scope it comes from and lets you choose which file to write. CuciCode\'s own settings follow the same pattern under .claude/cucicode/.',
    docs: 'https://code.claude.com/docs/en/settings',
  },
];

export function concept(id: string): Concept | undefined {
  return CONCEPTS.find((entry) => entry.id === id);
}

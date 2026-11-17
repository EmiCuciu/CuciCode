import type { TimelineEvent } from '@cucicode/protocol';

export interface Explanation {
  text: string;
  conceptId: string | null;
}

const BUILT_IN_TOOLS: Record<string, string> = {
  Read: 'reads a file so its contents enter the conversation',
  Write: 'creates or overwrites a whole file',
  Edit: 'replaces an exact piece of text in a file',
  MultiEdit: 'makes several replacements in one file at once',
  NotebookEdit: 'changes a cell in a Jupyter notebook',
  Bash: 'runs a shell command',
  PowerShell: 'runs a PowerShell command',
  Grep: 'searches file contents with a regular expression',
  Glob: 'finds files by name pattern',
  WebFetch: 'downloads a web page and extracts what was asked',
  WebSearch: 'searches the web',
  TodoWrite: 'updates the task list Claude keeps for itself',
};

const HOOK_EVENTS: Record<string, string> = {
  PreToolUse: 'before a tool runs; it can allow, block or change the call',
  PostToolUse: 'after a tool succeeded; it can add feedback for the model',
  PostToolUseFailure: 'after a tool failed',
  UserPromptSubmit: 'when a message is sent, before the model sees it',
  Stop: 'when Claude finishes responding; it can make it continue',
  SubagentStart: 'when a subagent starts',
  SubagentStop: 'when a subagent finishes',
  SessionStart: 'when a session starts or resumes',
  SessionEnd: 'when the session ends',
  PreCompact: 'before the conversation is compacted',
  PermissionRequest: 'when Claude Code is about to ask for permission',
  Notification: 'when Claude Code sends a notification',
};

const tokens = (value: number): string => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));

/**
 * A short, specific explanation of one timeline event, built from the event's own fields.
 * Nothing is sent to a model, so "Explain" costs no usage and is always the same.
 */
export function explain(event: TimelineEvent): Explanation | null {
  switch (event.kind) {
    case 'tool_call': {
      if (event.mcp) {
        return {
          text: `The model called the tool "${event.mcp.tool}" on the MCP server "${event.mcp.server}". Claude Code sent the input to that server and gave its answer back to the model as the tool result.`,
          conceptId: 'mcp',
        };
      }
      if (event.category === 'subagent') {
        return {
          text: `The main agent delegated a task to a "${event.subagentType ?? 'general-purpose'}" subagent. It works in its own context, and only its final report comes back, which keeps this conversation small. Its own steps are in the nested thread.`,
          conceptId: 'subagent',
        };
      }
      if (event.category === 'skill') {
        return {
          text: `The skill "${event.skillName ?? event.toolName}" was loaded: its full instructions entered the conversation now, because the model judged them relevant (or you ran it as a command). Until then only its description was in context.`,
          conceptId: 'skill',
        };
      }
      const what = BUILT_IN_TOOLS[event.toolName];
      return {
        text: what
          ? `${event.toolName} ${what}. The model asked for it; permission rules and hooks decided whether it ran, and the result was sent back to the model.`
          : `The model called the tool ${event.toolName}. The result was sent back to it as the next input.`,
        conceptId: 'permissions',
      };
    }
    case 'subagent':
      return {
        text: `A ${event.subagentType ?? 'subagent'} task (${event.description || 'no description'}) is ${event.status}.${event.usage ? ` It used ${tokens(event.usage.totalTokens)} tokens and ${event.usage.toolUses} tool calls in its own context.` : ''}`,
        conceptId: 'subagent',
      };
    case 'hook': {
      const when = HOOK_EVENTS[event.hookEvent] ?? 'at a fixed point in the session';
      const outcome =
        event.outcome === 'error' && event.exitCode === 2
          ? ' It exited with code 2, which blocks the action and shows its message to the model.'
          : event.outcome === 'error'
            ? ` It failed (exit ${event.exitCode ?? 'unknown'}); a failure other than exit 2 does not block.`
            : event.outcome === 'success'
              ? ' It succeeded, so the action went ahead.'
              : '';
      return { text: `The hook "${event.hookName}" ran on ${event.hookEvent}, which fires ${when}. Hooks are configured commands that always run, whatever the model decides.${outcome}`, conceptId: 'hook' };
    }
    case 'permission_request':
      return {
        text: `Claude Code paused before running ${event.toolName}: no permission rule allowed it in the current mode, so it asks you. "Always allow" saves a rule so it will not ask again for the same kind of call.`,
        conceptId: 'permissions',
      };
    case 'compaction':
      return {
        text: `The conversation was ${event.trigger === 'auto' ? 'compacted automatically because the context window was nearly full' : 'compacted because you asked'}: ${tokens(event.preTokens)} tokens of history were replaced by a summary${event.postTokens !== null ? ` of about ${tokens(event.postTokens)}` : ''}. The work continues, but details from before are now only in the summary.`,
        conceptId: 'compact-vs-clear',
      };
    case 'system_init':
      return {
        text: `Claude Code ${event.claudeCodeVersion} started this session with ${event.model} in ${event.permissionMode} mode, the ${event.outputStyle} output style, ${event.tools.length} tools, ${event.skills.length} skills, ${event.agents.length} agents and ${event.mcpServers.length} MCP servers, all loaded from the settings files in scope.`,
        conceptId: 'settings-scopes',
      };
    case 'thinking':
      return { text: 'The model reasoned before answering. This text is its working; only the answer that follows is meant as the reply.', conceptId: null };
    case 'result':
      return {
        text: `The turn ended (${event.subtype}) after ${event.numTurns} model call(s) in ${(event.durationMs / 1000).toFixed(1)}s. The token counts include subagents. Cache reads are earlier context re-read cheaply.`,
        conceptId: 'context',
      };
    default:
      return null;
  }
}

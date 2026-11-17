import type {
  EventCategory,
  ModelUsageSummary,
  TimelineEvent,
  ToolCallEvent,
} from '@cucicode/protocol';

export const MAX_RESULT_CHARS = 20_000;

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SKILL_TOOL = 'Skill';
const MCP_PREFIX = 'mcp__';

export type NormalizeSource = 'live' | 'history';

export interface NormalizeContext {
  source: NormalizeSource;
  now: () => number | null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function classifyTool(toolName: string, input: unknown): Pick<ToolCallEvent, 'category' | 'mcp' | 'skillName' | 'subagentType'> {
  const fields = isDict(input) ? input : {};
  if (SUBAGENT_TOOLS.has(toolName)) {
    return { category: 'subagent', subagentType: str(fields.subagent_type, 'general-purpose') };
  }
  if (toolName === SKILL_TOOL) {
    return { category: 'skill', skillName: str(fields.skill, str(fields.command)) };
  }
  if (toolName.startsWith(MCP_PREFIX)) {
    const [server = '', ...rest] = toolName.slice(MCP_PREFIX.length).split('__');
    return { category: 'mcp', mcp: { server, tool: rest.join('__') } };
  }
  return { category: 'tool' };
}

export function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : JSON.stringify(content);
  }
  return content
    .map((block) => {
      if (!isDict(block)) {
        return '';
      }
      if (block.type === 'text') {
        return str(block.text);
      }
      return `[${str(block.type, 'content')}]`;
    })
    .join('\n');
}

function blocksOf(message: unknown): Dict[] {
  if (!isDict(message)) {
    return [];
  }
  const content = message.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content.filter(isDict) : [];
}

function normalizeAssistant(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  const uuid = str(msg.uuid, 'assistant');
  const parentToolUseId = strOrNull(msg.parent_tool_use_id);
  const events: TimelineEvent[] = [];
  blocksOf(msg.message).forEach((block, index) => {
    const id = `${uuid}:${index}`;
    const ts = ctx.now();
    if (block.type === 'text' && str(block.text).trim().length > 0) {
      events.push({ kind: 'assistant_text', id, ts, category: 'message', parentToolUseId, messageId: uuid, text: str(block.text) });
    } else if (block.type === 'thinking' && str(block.thinking).trim().length > 0) {
      events.push({ kind: 'thinking', id, ts, category: 'thinking', parentToolUseId, messageId: uuid, text: str(block.thinking) });
    } else if (block.type === 'tool_use') {
      const toolName = str(block.name);
      events.push({
        kind: 'tool_call',
        id,
        ts,
        parentToolUseId,
        toolUseId: str(block.id),
        toolName,
        input: block.input,
        ...classifyTool(toolName, block.input),
      });
    }
  });
  return events;
}

function normalizeUser(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  const uuid = str(msg.uuid, 'user');
  const parentToolUseId = strOrNull(msg.parent_tool_use_id);
  const showText = ctx.source === 'history' || parentToolUseId !== null;
  const events: TimelineEvent[] = [];
  const textParts: string[] = [];
  let attachmentCount = 0;
  blocksOf(msg.message).forEach((block, index) => {
    if (block.type === 'tool_result') {
      const full = flattenToolResult(block.content);
      events.push({
        kind: 'tool_result',
        id: `${uuid}:${index}`,
        ts: ctx.now(),
        category: 'tool',
        parentToolUseId,
        toolUseId: str(block.tool_use_id),
        content: full.slice(0, MAX_RESULT_CHARS),
        isError: block.is_error === true,
        truncated: full.length > MAX_RESULT_CHARS,
      });
    } else if (block.type === 'text') {
      textParts.push(str(block.text));
    } else if (block.type === 'image' || block.type === 'document') {
      attachmentCount += 1;
    }
  });
  const text = textParts.join('\n').trim();
  if (showText && msg.isSynthetic !== true && (text.length > 0 || attachmentCount > 0)) {
    events.unshift({ kind: 'user_message', id: `${uuid}:text`, ts: ctx.now(), category: 'message', parentToolUseId, text, attachmentCount });
  }
  return events;
}

function normalizeStreamEvent(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  const event = isDict(msg.event) ? msg.event : {};
  const delta = isDict(event.delta) ? event.delta : {};
  if (event.type !== 'content_block_delta') {
    return [];
  }
  const deltaType = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : null;
  if (deltaType === null) {
    return [];
  }
  const text = deltaType === 'text' ? str(delta.text) : str(delta.thinking);
  return [{
    kind: 'stream_delta',
    id: str(msg.uuid, 'delta'),
    ts: ctx.now(),
    category: deltaType === 'text' ? 'message' : 'thinking',
    parentToolUseId: strOrNull(msg.parent_tool_use_id),
    blockIndex: num(event.index),
    deltaType,
    text,
  }];
}

function summarizeModelUsage(value: unknown): Record<string, ModelUsageSummary> {
  const summary: Record<string, ModelUsageSummary> = {};
  if (!isDict(value)) {
    return summary;
  }
  for (const [model, raw] of Object.entries(value)) {
    const usage = isDict(raw) ? raw : {};
    summary[model] = {
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadInputTokens: num(usage.cacheReadInputTokens),
      cacheCreationInputTokens: num(usage.cacheCreationInputTokens),
      costUsd: num(usage.costUSD),
      contextWindow: num(usage.contextWindow),
    };
  }
  return summary;
}

function taskUsage(value: unknown): { totalTokens: number; toolUses: number; durationMs: number } | null {
  if (!isDict(value)) {
    return null;
  }
  return { totalTokens: num(value.total_tokens), toolUses: num(value.tool_uses), durationMs: num(value.duration_ms) };
}

function normalizeSystem(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  const id = str(msg.uuid, `system:${str(msg.subtype)}`);
  const ts = ctx.now();
  const base = { id, ts, parentToolUseId: null };
  switch (msg.subtype) {
    case 'init':
      return [{
        ...base,
        kind: 'system_init',
        category: 'system',
        sessionId: str(msg.session_id),
        model: str(msg.model),
        permissionMode: str(msg.permissionMode),
        cwd: str(msg.cwd),
        claudeCodeVersion: str(msg.claude_code_version),
        authSource: str(msg.apiKeySource, 'unknown'),
        outputStyle: str(msg.output_style),
        effort: strOrNull(msg.effort),
        tools: strArray(msg.tools),
        slashCommands: strArray(msg.slash_commands),
        terminalSlashCommands: strArray(msg.terminal_slash_commands),
        skills: strArray(msg.skills),
        agents: strArray(msg.agents),
        mcpServers: (Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [])
          .filter(isDict)
          .map((server) => ({ name: str(server.name), status: str(server.status) })),
        plugins: (Array.isArray(msg.plugins) ? msg.plugins : [])
          .filter(isDict)
          .map((plugin) => ({ name: str(plugin.name), path: str(plugin.path) })),
      }];
    case 'compact_boundary': {
      const meta = isDict(msg.compact_metadata) ? msg.compact_metadata : {};
      return [{
        ...base,
        kind: 'compaction',
        category: 'compaction',
        trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
        preTokens: num(meta.pre_tokens),
        postTokens: numOrNull(meta.post_tokens),
      }];
    }
    case 'hook_started':
    case 'hook_response': {
      const finished = msg.subtype === 'hook_response';
      const outcome = msg.outcome === 'success' || msg.outcome === 'error' || msg.outcome === 'cancelled' ? msg.outcome : null;
      return [{
        ...base,
        kind: 'hook',
        category: 'hook',
        phase: finished ? 'finished' : 'started',
        hookId: str(msg.hook_id),
        hookName: str(msg.hook_name),
        hookEvent: str(msg.hook_event),
        outcome: finished ? outcome : null,
        exitCode: numOrNull(msg.exit_code),
        output: str(msg.output, str(msg.stdout)),
      }];
    }
    case 'hook_progress':
      return [];
    case 'task_started':
    case 'task_progress':
    case 'task_notification': {
      const finished = msg.subtype === 'task_notification';
      const status = msg.status === 'completed' || msg.status === 'failed' || msg.status === 'stopped' ? msg.status : 'running';
      return [{
        ...base,
        kind: 'subagent',
        category: 'subagent',
        phase: finished ? 'finished' : msg.subtype === 'task_started' ? 'started' : 'progress',
        taskId: str(msg.task_id),
        toolUseId: strOrNull(msg.tool_use_id),
        description: str(msg.description),
        subagentType: strOrNull(msg.subagent_type),
        status: finished ? status : 'running',
        summary: strOrNull(msg.summary),
        usage: taskUsage(msg.usage),
      }];
    }
    case 'status':
      return msg.status === null || msg.status === undefined
        ? []
        : [{ ...base, kind: 'status', category: 'system', status: str(msg.status, JSON.stringify(msg.status)) }];
    case 'session_state_changed': {
      const state = msg.state === 'running' || msg.state === 'requires_action' ? msg.state : 'idle';
      return [{ ...base, kind: 'session_state', category: 'system', state }];
    }
    case 'informational':
      return [{ ...base, kind: 'notice', category: 'system', level: msg.level === 'warning' ? 'warning' : 'info', text: str(msg.content) }];
    case 'conversation_reset':
      return [{ ...base, kind: 'notice', category: 'system', level: 'info', text: 'Conversation cleared' }];
    case 'local_command_output':
      return [{ ...base, kind: 'notice', category: 'system', level: 'info', text: str(msg.content) }];
    default:
      return [{ ...base, kind: 'raw', category: 'system', sdkType: 'system', sdkSubtype: strOrNull(msg.subtype) }];
  }
}

function normalizeResult(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  return [{
    kind: 'result',
    id: str(msg.uuid, 'result'),
    ts: ctx.now(),
    category: 'result',
    parentToolUseId: null,
    subtype: str(msg.subtype),
    isError: msg.is_error === true,
    durationMs: num(msg.duration_ms),
    numTurns: num(msg.num_turns),
    estimatedCostUsd: num(msg.total_cost_usd),
    modelUsage: summarizeModelUsage(msg.modelUsage),
    errors: strArray(msg.errors),
  }];
}

function normalizeRateLimit(msg: Dict, ctx: NormalizeContext): TimelineEvent[] {
  const info = isDict(msg.rate_limit_info) ? msg.rate_limit_info : {};
  const status = info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : 'allowed';
  return [{
    kind: 'rate_limit',
    id: str(msg.uuid, 'rate_limit'),
    ts: ctx.now(),
    category: 'system',
    parentToolUseId: null,
    status,
    window: strOrNull(info.rateLimitType),
    utilization: numOrNull(info.utilization),
    resetsAt: numOrNull(info.resetsAt),
  }];
}

const SILENT_TYPES = new Set(['tool_progress', 'prompt_suggestion', 'thinking_tokens', 'tool_use_summary']);

export function normalizeMessage(message: unknown, ctx: NormalizeContext): TimelineEvent[] {
  if (!isDict(message)) {
    return [];
  }
  const type = str(message.type);
  switch (type) {
    case 'assistant':
      return normalizeAssistant(message, ctx);
    case 'user':
      return normalizeUser(message, ctx);
    case 'stream_event':
      return normalizeStreamEvent(message, ctx);
    case 'system':
      return normalizeSystem(message, ctx);
    case 'result':
      return normalizeResult(message, ctx);
    case 'rate_limit_event':
      return normalizeRateLimit(message, ctx);
    default: {
      if (SILENT_TYPES.has(type)) {
        return [];
      }
      const category: EventCategory = 'system';
      return [{
        kind: 'raw',
        id: str(message.uuid, `raw:${type}`),
        ts: ctx.now(),
        category,
        parentToolUseId: null,
        sdkType: type,
        sdkSubtype: strOrNull(message.subtype),
      }];
    }
  }
}

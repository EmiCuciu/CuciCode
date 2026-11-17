export type EventCategory =
  | 'message'
  | 'thinking'
  | 'tool'
  | 'subagent'
  | 'skill'
  | 'mcp'
  | 'hook'
  | 'permission'
  | 'compaction'
  | 'system'
  | 'result';

export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'message',
  'thinking',
  'tool',
  'subagent',
  'skill',
  'mcp',
  'hook',
  'permission',
  'compaction',
  'system',
  'result',
];

interface EventBase {
  id: string;
  ts: number | null;
  category: EventCategory;
  parentToolUseId: string | null;
}

export interface UserMessageEvent extends EventBase {
  kind: 'user_message';
  text: string;
  attachmentCount: number;
}

export interface AssistantTextEvent extends EventBase {
  kind: 'assistant_text';
  messageId: string;
  text: string;
}

export interface ThinkingEvent extends EventBase {
  kind: 'thinking';
  messageId: string;
  text: string;
}

export interface StreamDeltaEvent extends EventBase {
  kind: 'stream_delta';
  blockIndex: number;
  deltaType: 'text' | 'thinking';
  text: string;
}

export interface ToolCallEvent extends EventBase {
  kind: 'tool_call';
  toolUseId: string;
  toolName: string;
  input: unknown;
  mcp?: { server: string; tool: string };
  skillName?: string;
  subagentType?: string;
}

export interface ToolResultEvent extends EventBase {
  kind: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
  truncated: boolean;
}

export interface SubagentEvent extends EventBase {
  kind: 'subagent';
  phase: 'started' | 'progress' | 'finished';
  taskId: string;
  toolUseId: string | null;
  description: string;
  subagentType: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
}

export interface HookEvent extends EventBase {
  kind: 'hook';
  phase: 'started' | 'finished';
  hookId: string;
  hookName: string;
  hookEvent: string;
  outcome: 'success' | 'error' | 'cancelled' | null;
  exitCode: number | null;
  output: string;
}

export interface PermissionRequestEvent extends EventBase {
  kind: 'permission_request';
  requestId: string;
  toolName: string;
  input: unknown;
  title: string | null;
  description: string | null;
  canRemember: boolean;
}

export interface PermissionResolvedEvent extends EventBase {
  kind: 'permission_resolved';
  requestId: string;
  outcome: 'allowed' | 'denied' | 'cancelled';
}

export interface CompactionEvent extends EventBase {
  kind: 'compaction';
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens: number | null;
}

export interface SystemInitEvent extends EventBase {
  kind: 'system_init';
  sessionId: string;
  model: string;
  permissionMode: string;
  cwd: string;
  claudeCodeVersion: string;
  authSource: string;
  outputStyle: string;
  effort: string | null;
  tools: string[];
  slashCommands: string[];
  /** Commands that only work in the interactive terminal, as reported by Claude Code. */
  terminalSlashCommands: string[];
  skills: string[];
  agents: string[];
  mcpServers: { name: string; status: string }[];
  plugins: { name: string; path: string }[];
}

export interface StatusEvent extends EventBase {
  kind: 'status';
  status: string;
}

export interface SessionStateEvent extends EventBase {
  kind: 'session_state';
  state: 'idle' | 'running' | 'requires_action';
}

export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  contextWindow: number;
}

export interface ResultEvent extends EventBase {
  kind: 'result';
  subtype: string;
  isError: boolean;
  durationMs: number;
  numTurns: number;
  estimatedCostUsd: number;
  modelUsage: Record<string, ModelUsageSummary>;
  errors: string[];
}

export interface RateLimitEvent extends EventBase {
  kind: 'rate_limit';
  status: 'allowed' | 'allowed_warning' | 'rejected';
  window: string | null;
  utilization: number | null;
  resetsAt: number | null;
}

export interface NoticeEvent extends EventBase {
  kind: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface RawEvent extends EventBase {
  kind: 'raw';
  sdkType: string;
  sdkSubtype: string | null;
}

export type TimelineEvent =
  | UserMessageEvent
  | AssistantTextEvent
  | ThinkingEvent
  | StreamDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubagentEvent
  | HookEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | CompactionEvent
  | SystemInitEvent
  | StatusEvent
  | SessionStateEvent
  | ResultEvent
  | RateLimitEvent
  | NoticeEvent
  | RawEvent;

export type TimelineEventKind = TimelineEvent['kind'];

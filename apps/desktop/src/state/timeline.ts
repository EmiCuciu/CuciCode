import type {
  EventCategory,
  HookEvent,
  RateLimitEvent,
  ResultEvent,
  SubagentEvent,
  SystemInitEvent,
  TimelineEvent,
  ToolResultEvent,
} from '@cucicode/protocol';

export type DisplayEvent = Exclude<
  TimelineEvent,
  { kind: 'stream_delta' | 'tool_result' | 'permission_resolved' | 'status' | 'session_state' | 'rate_limit' }
>;

export interface TimelineState {
  events: DisplayEvent[];
  results: Record<string, ToolResultEvent>;
  permissionOutcomes: Record<string, 'allowed' | 'denied' | 'cancelled'>;
  draft: { text: string; thinking: string } | null;
  runState: 'idle' | 'running' | 'requires_action';
  status: string | null;
  init: SystemInitEvent | null;
  lastResult: ResultEvent | null;
  rateLimit: RateLimitEvent | null;
}

export const emptyTimeline: TimelineState = {
  events: [],
  results: {},
  permissionOutcomes: {},
  draft: null,
  runState: 'idle',
  status: null,
  init: null,
  lastResult: null,
  rateLimit: null,
};

function replaceWhere(events: DisplayEvent[], match: (event: DisplayEvent) => boolean, next: DisplayEvent): DisplayEvent[] {
  const index = events.findIndex(match);
  if (index === -1) {
    return [...events, next];
  }
  const copy = events.slice();
  copy[index] = next;
  return copy;
}

function mergeHook(events: DisplayEvent[], hook: HookEvent): DisplayEvent[] {
  return replaceWhere(events, (event) => event.kind === 'hook' && event.hookId === hook.hookId, hook);
}

function mergeSubagent(events: DisplayEvent[], subagent: SubagentEvent): DisplayEvent[] {
  const existing = events.find((event): event is SubagentEvent => event.kind === 'subagent' && event.taskId === subagent.taskId);
  const merged: SubagentEvent = existing
    ? {
        ...subagent,
        id: existing.id,
        ts: existing.ts,
        description: subagent.description || existing.description,
        subagentType: subagent.subagentType ?? existing.subagentType,
        toolUseId: subagent.toolUseId ?? existing.toolUseId,
      }
    : subagent;
  return replaceWhere(events, (event) => event.kind === 'subagent' && event.taskId === subagent.taskId, merged);
}

export function applyEvent(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.kind) {
    case 'stream_delta': {
      if (event.parentToolUseId !== null) {
        return state;
      }
      const draft = state.draft ?? { text: '', thinking: '' };
      return {
        ...state,
        draft: event.deltaType === 'text' ? { ...draft, text: draft.text + event.text } : { ...draft, thinking: draft.thinking + event.text },
      };
    }
    case 'assistant_text':
    case 'thinking':
      return {
        ...state,
        events: [...state.events, event],
        draft: event.parentToolUseId === null ? null : state.draft,
      };
    case 'tool_result':
      return { ...state, results: { ...state.results, [event.toolUseId]: event } };
    case 'permission_resolved':
      return { ...state, permissionOutcomes: { ...state.permissionOutcomes, [event.requestId]: event.outcome } };
    case 'hook':
      return { ...state, events: mergeHook(state.events, event) };
    case 'subagent':
      return { ...state, events: mergeSubagent(state.events, event) };
    case 'status':
      return { ...state, status: event.status };
    case 'session_state':
      return { ...state, runState: event.state, status: event.state === 'idle' ? null : state.status, draft: event.state === 'idle' ? null : state.draft };
    case 'rate_limit':
      return { ...state, rateLimit: event };
    case 'system_init':
      return { ...state, init: event, events: [...state.events, event] };
    case 'user_message':
      return {
        ...state,
        events: [...state.events, event],
        runState: event.parentToolUseId === null ? 'running' : state.runState,
      };
    case 'result':
      return { ...state, events: [...state.events, event], lastResult: event, draft: null, status: null, runState: 'idle' };
    default:
      return { ...state, events: [...state.events, event] };
  }
}

export function fromHistory(events: TimelineEvent[]): TimelineState {
  return { ...events.reduce(applyEvent, emptyTimeline), runState: 'idle', draft: null, status: null };
}

export interface TimelineRow {
  event: DisplayEvent;
  repeat: number;
}

function collapseKey(event: DisplayEvent): string | null {
  switch (event.kind) {
    case 'raw':
      return `raw:${event.sdkType}:${event.sdkSubtype ?? ''}`;
    case 'notice':
      return `notice:${event.level}:${event.text}`;
    case 'hook':
      return event.phase === 'finished' ? `hook:${event.hookEvent}:${event.hookName}:${event.outcome ?? ''}:${event.output}` : null;
    default:
      return null;
  }
}

export function buildRows(events: DisplayEvent[], parentToolUseId: string | null, hidden: ReadonlySet<EventCategory>): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previousKey: string | null = null;
  for (const event of events) {
    if (event.parentToolUseId !== parentToolUseId || hidden.has(event.category)) {
      continue;
    }
    const key = collapseKey(event);
    const last = rows[rows.length - 1];
    if (key !== null && key === previousKey && last) {
      last.repeat += 1;
    } else {
      rows.push({ event, repeat: 1 });
    }
    previousKey = key;
  }
  return rows;
}

export function hasChildren(events: DisplayEvent[], toolUseId: string): boolean {
  return events.some((event) => event.parentToolUseId === toolUseId);
}

export function totalTokens(result: ResultEvent | null): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of Object.values(result?.modelUsage ?? {})) {
    totals.input += usage.inputTokens;
    totals.output += usage.outputTokens;
    totals.cacheRead += usage.cacheReadInputTokens;
    totals.cacheWrite += usage.cacheCreationInputTokens;
  }
  return totals;
}

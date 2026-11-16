import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@cucicode/protocol';
import { applyEvent, buildRows, emptyTimeline, fromHistory, hasChildren, totalTokens } from './timeline.ts';

const base = { ts: 1, parentToolUseId: null } as const;
const delta = (text: string, deltaType: 'text' | 'thinking' = 'text'): TimelineEvent => ({
  ...base,
  kind: 'stream_delta',
  id: 'd',
  category: 'message',
  blockIndex: 0,
  deltaType,
  text,
});
const assistant = (id: string, text: string, parentToolUseId: string | null = null): TimelineEvent => ({
  ...base,
  kind: 'assistant_text',
  id,
  category: 'message',
  messageId: id,
  text,
  parentToolUseId,
});
const notice = (id: string, text: string): TimelineEvent => ({ ...base, kind: 'notice', id, category: 'system', level: 'info', text });
const run = (events: TimelineEvent[]) => events.reduce(applyEvent, emptyTimeline);

describe('applyEvent', () => {
  it('accumulates stream deltas into a draft and clears it when the final message arrives', () => {
    const streaming = run([delta('Hel'), delta('lo'), delta('hm', 'thinking')]);
    expect(streaming.draft).toEqual({ text: 'Hello', thinking: 'hm' });
    expect(streaming.events).toHaveLength(0);
    const done = applyEvent(streaming, assistant('a', 'Hello'));
    expect(done.draft).toBeNull();
    expect(done.events).toHaveLength(1);
  });

  it('keeps tool results and permission outcomes out of the event list, keyed for lookup', () => {
    const state = run([
      { ...base, kind: 'tool_call', id: 'c', category: 'tool', toolUseId: 't1', toolName: 'Bash', input: {} },
      { ...base, kind: 'tool_result', id: 'r', category: 'tool', toolUseId: 't1', content: 'ok', isError: false, truncated: false },
      { ...base, kind: 'permission_request', id: 'p', category: 'permission', requestId: 'p', toolName: 'Bash', input: {}, title: null, description: null, canRemember: false },
      { ...base, kind: 'permission_resolved', id: 'p:resolved', category: 'permission', requestId: 'p', outcome: 'allowed' },
    ]);
    expect(state.events.map((event) => event.kind)).toEqual(['tool_call', 'permission_request']);
    expect(state.results.t1?.content).toBe('ok');
    expect(state.permissionOutcomes.p).toBe('allowed');
  });

  it('merges hook and subagent lifecycle events into one row each', () => {
    const hook = (phase: 'started' | 'finished'): TimelineEvent => ({
      ...base,
      kind: 'hook',
      id: `h-${phase}`,
      category: 'hook',
      phase,
      hookId: 'h1',
      hookName: 'guard',
      hookEvent: 'PreToolUse',
      outcome: phase === 'finished' ? 'success' : null,
      exitCode: phase === 'finished' ? 0 : null,
      output: '',
    });
    const sub = (phase: 'started' | 'finished', description: string): TimelineEvent => ({
      ...base,
      kind: 'subagent',
      id: `s-${phase}`,
      category: 'subagent',
      phase,
      taskId: 'k1',
      toolUseId: phase === 'started' ? 'tu' : null,
      description,
      subagentType: phase === 'started' ? 'Explore' : null,
      status: phase === 'finished' ? 'completed' : 'running',
      summary: phase === 'finished' ? 'done' : null,
      usage: null,
    });
    const state = run([hook('started'), sub('started', 'map repo'), hook('finished'), sub('finished', '')]);
    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({ kind: 'hook', phase: 'finished', outcome: 'success' });
    expect(state.events[1]).toMatchObject({ kind: 'subagent', status: 'completed', description: 'map repo', subagentType: 'Explore', toolUseId: 'tu', id: 's-started' });
  });

  it('tracks run state from user messages, results and session state', () => {
    const user: TimelineEvent = { ...base, kind: 'user_message', id: 'u', category: 'message', text: 'hi', attachmentCount: 0 };
    const result: TimelineEvent = {
      ...base,
      kind: 'result',
      id: 'r',
      category: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 1,
      numTurns: 1,
      estimatedCostUsd: 0,
      modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUsd: 0, contextWindow: 1 } },
      errors: [],
    };
    const running = run([user, delta('x')]);
    expect(running.runState).toBe('running');
    const finished = applyEvent(running, result);
    expect(finished.runState).toBe('idle');
    expect(finished.draft).toBeNull();
    expect(totalTokens(finished.lastResult)).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it('loads history as idle regardless of the events it contains', () => {
    const state = fromHistory([{ ...base, kind: 'user_message', id: 'u', category: 'message', text: 'hi', attachmentCount: 0 }]);
    expect(state.runState).toBe('idle');
    expect(state.events).toHaveLength(1);
  });
});

describe('buildRows', () => {
  it('hides filtered categories and nests by parent tool use', () => {
    const state = run([assistant('a', 'top'), assistant('b', 'inner', 'task1'), notice('n', 'x')]);
    expect(buildRows(state.events, null, new Set()).map((row) => row.event.id)).toEqual(['a', 'n']);
    expect(buildRows(state.events, null, new Set(['system'])).map((row) => row.event.id)).toEqual(['a']);
    expect(buildRows(state.events, 'task1', new Set()).map((row) => row.event.id)).toEqual(['b']);
    expect(hasChildren(state.events, 'task1')).toBe(true);
    expect(hasChildren(state.events, 'other')).toBe(false);
  });

  it('collapses consecutive identical system events into one row with a counter', () => {
    const state = run([notice('1', 'same'), notice('2', 'same'), notice('3', 'same'), notice('4', 'other'), notice('5', 'same')]);
    const rows = buildRows(state.events, null, new Set());
    expect(rows.map((row) => [row.event.id, row.repeat])).toEqual([['1', 3], ['4', 1], ['5', 1]]);
  });

  it('does not collapse across a hidden or different event in between', () => {
    const state = run([notice('1', 'same'), assistant('a', 'hi'), notice('2', 'same')]);
    expect(buildRows(state.events, null, new Set()).map((row) => row.repeat)).toEqual([1, 1, 1]);
  });
});

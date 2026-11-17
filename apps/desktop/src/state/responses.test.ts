import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@cucicode/protocol';
import { responseMarks } from './responses.ts';
import { applyEvent, emptyTimeline, fromHistory } from './timeline.ts';

const user = (id: string, ts: number | null, parentToolUseId: string | null = null): TimelineEvent => ({
  kind: 'user_message',
  id,
  ts,
  category: 'message',
  parentToolUseId,
  text: 'hi',
  attachmentCount: 0,
});
const text = (id: string, ts: number | null, parentToolUseId: string | null = null): TimelineEvent => ({
  kind: 'assistant_text',
  id,
  ts,
  category: 'message',
  parentToolUseId,
  messageId: id,
  text: 'answer',
});
const result = (id: string, ts: number | null): TimelineEvent => ({
  kind: 'result',
  id,
  ts,
  category: 'result',
  parentToolUseId: null,
  subtype: 'success',
  isError: false,
  durationMs: 0,
  numTurns: 1,
  estimatedCostUsd: 0,
  modelUsage: {},
  errors: [],
});
const toolResult = (toolUseId: string, ts: number | null): TimelineEvent => ({
  kind: 'tool_result',
  id: `r-${toolUseId}`,
  ts,
  category: 'tool',
  parentToolUseId: null,
  toolUseId,
  content: 'done',
  isError: false,
  truncated: false,
});
const sessionState = (state: 'idle' | 'running'): TimelineEvent => ({
  kind: 'session_state',
  id: `s-${state}`,
  ts: 0,
  category: 'system',
  parentToolUseId: null,
  state,
});
const live = (events: TimelineEvent[]) => events.reduce(applyEvent, emptyTimeline);

describe('responseMarks', () => {
  it('stamps the user message and only the first assistant text of a response', () => {
    const marks = responseMarks(fromHistory([user('u', 1000), text('a1', 2000), text('a2', 3000)]), null);
    expect([...marks.stampIds]).toEqual(['u', 'a1']);
  });

  it('stamps the first assistant text when the timeline starts without a user message', () => {
    const marks = responseMarks(fromHistory([text('a1', 2000), text('a2', 3000)]), null);
    expect([...marks.stampIds]).toEqual(['a1']);
    expect(marks.durations.size).toBe(0);
  });

  it('ends a live response at the result event and puts the duration after it', () => {
    const timeline = live([user('u', 1000), text('a', 2000), result('r', 5000), sessionState('idle')]);
    expect(responseMarks(timeline, null).durations.get('r')).toBe(4000);
  });

  it('ends a reopened response at its latest event when no result was recorded', () => {
    const marks = responseMarks(fromHistory([user('u', 1000), text('a', 2000), text('b', 4000)]), null);
    expect([...marks.durations]).toEqual([['b', 3000]]);
  });

  it('measures an interrupted run up to its last event', () => {
    const timeline = live([user('u', 1000), text('a', 2500), sessionState('idle')]);
    expect(responseMarks(timeline, null).durations.get('a')).toBe(1500);
  });

  it('returns no duration while the response is still running', () => {
    const timeline = live([user('u', 1000), text('a', 2000)]);
    expect(responseMarks(timeline, null).durations.size).toBe(0);
  });

  it('cuts the first response at a queued message and completes it', () => {
    const timeline = live([user('u1', 1000), text('a1', 2000), user('u2', 3000), text('a2', 4000)]);
    const marks = responseMarks(timeline, null);
    expect([...marks.durations]).toEqual([['a1', 1000]]);
    expect([...marks.stampIds]).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('returns no duration when a timestamp is missing or the end precedes the start', () => {
    expect(responseMarks(fromHistory([user('u', null), text('a', 2000)]), null).durations.size).toBe(0);
    expect(responseMarks(fromHistory([user('u', 1000), text('a', 2000), result('r', null)]), null).durations.size).toBe(0);
    expect(responseMarks(fromHistory([user('u', 5000), text('a', 6000), result('r', 2000)]), null).durations.size).toBe(0);
  });

  it('places the duration after the last visible row and drops it when none is visible', () => {
    const timeline = fromHistory([user('u', 1000), text('a', 2000), result('r', 5000)]);
    expect(responseMarks(timeline, null, new Set(['result'])).durations.get('a')).toBe(4000);
    expect(responseMarks(timeline, null, new Set(['message', 'result'])).durations.size).toBe(0);
  });

  it('works on a subagent thread and ends it at the parent tool result', () => {
    const events = [user('u', 1000), text('a', 2000), user('su', 2100, 't1'), text('sa', 2200, 't1'), text('sb', 2300, 't1')];
    expect(responseMarks(live(events), 't1').durations.size).toBe(0);
    const marks = responseMarks(live([...events, toolResult('t1', 6100)]), 't1');
    expect([...marks.stampIds]).toEqual(['su', 'sa']);
    expect([...marks.durations]).toEqual([['sb', 4000]]);
  });

  it('keeps main thread and subagent thread events apart', () => {
    const timeline = fromHistory([user('u', 1000), text('a', 2000), text('sa', 2500, 't1')]);
    expect([...responseMarks(timeline, null).stampIds]).toEqual(['u', 'a']);
  });
});

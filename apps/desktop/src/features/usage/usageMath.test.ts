import { describe, expect, it } from 'vitest';
import { attribute, burnRate, FIVE_HOURS_MS, formatTokens, HOUR_MS, isStale, outlook, roleOf, since, sumBy, type UsageRow } from './usageMath.ts';

const row = (partial: Partial<UsageRow>): UsageRow => ({ project: 'C--work-app', sessionId: 's1', agent: 'main', model: 'sonnet', hourStartMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1, ...partial });
const at = (text: string): number => Date.parse(text);

describe('sumBy', () => {
  it('totals per key, counts cache reads apart from fresh tokens, and sorts by fresh tokens', () => {
    const totals = sumBy([row({ model: 'haiku', input: 10, output: 5, cacheRead: 1000, cacheWrite: 5 }), row({ model: 'sonnet', input: 100, output: 50 }), row({ model: 'haiku', input: 1 })], (entry) => entry.model);
    expect(totals.map((total) => total.key)).toEqual(['sonnet', 'haiku']);
    expect(totals[1]).toMatchObject({ input: 11, output: 5, cacheRead: 1000, cacheWrite: 5, fresh: 21, messages: 2 });
  });

  it('keeps an hour bucket that overlaps the start of the range', () => {
    const rows = [row({ hourStartMs: 0 }), row({ hourStartMs: 2 * HOUR_MS })];
    expect(since(rows, HOUR_MS - 1)).toHaveLength(2);
    expect(since(rows, HOUR_MS)).toHaveLength(1);
  });
});

describe('attribute', () => {
  const projects = [{ id: 'C--WORK-CuciCode', name: 'CuciCode' }];

  it('matches a project folder and its story worktrees, ignoring case', () => {
    expect(attribute('C--WORK-CuciCode', projects)).toEqual({ projectId: 'C--WORK-CuciCode', name: 'CuciCode', storyId: null });
    expect(attribute('c--work-cucicode--claude-worktrees-S-001', projects)).toEqual({ projectId: 'C--WORK-CuciCode', name: 'CuciCode', storyId: 'S-001' });
    expect(attribute('C--other-thing', projects)).toEqual({ projectId: null, name: 'C--other-thing', storyId: null });
  });

  it('names the role behind a row', () => {
    const roles = { 'cucicode:planner': 'Planner' };
    expect(roleOf(row({ agent: 'main' }), null, roles)).toBe('Main thread');
    expect(roleOf(row({ agent: 'main' }), 'S-001', roles)).toBe('Worker');
    expect(roleOf(row({ agent: 'cucicode:planner' }), null, roles)).toBe('Planner');
    expect(roleOf(row({ agent: 'Explore' }), 'S-001', roles)).toBe('Explore');
  });
});

describe('outlook', () => {
  const resetsAt = '2026-11-16T15:00:00Z';
  const window = (utilization: number) => ({ utilization, resetsAt });

  it('says when the window runs out at the pace so far', () => {
    // The window opened at 10:00. 60% after two hours is 30% per hour, so 100% comes 80 minutes later.
    const result = outlook(window(60), at('2026-11-16T12:00:00Z'), FIVE_HOURS_MS);
    expect(result.kind).toBe('runs_out');
    expect(result.kind === 'runs_out' && result.ratePerHour).toBeCloseTo(30);
    expect(result.kind === 'runs_out' && new Date(result.runsOutAtMs).toISOString()).toBe('2026-11-16T13:20:00.000Z');
  });

  it('says the pace is fine when the reset comes first', () => {
    const result = outlook(window(20), at('2026-11-16T12:00:00Z'), FIVE_HOURS_MS);
    expect(result.kind).toBe('fine');
    expect(result.kind === 'fine' && result.ratePerHour).toBeCloseTo(10);
  });

  it('handles an exhausted window and missing data without guessing', () => {
    expect(outlook(window(100), at('2026-11-16T12:00:00Z'), FIVE_HOURS_MS).kind).toBe('exhausted');
    expect(outlook(null, 0, FIVE_HOURS_MS).kind).toBe('unknown');
    expect(outlook({ utilization: 50, resetsAt: null }, 0, FIVE_HOURS_MS).kind).toBe('unknown');
    expect(outlook(window(0), at('2026-11-16T12:00:00Z'), FIVE_HOURS_MS).kind).toBe('unknown');
    expect(outlook(window(50), at('2026-11-16T09:00:00Z'), FIVE_HOURS_MS).kind).toBe('unknown');
  });

  it('marks a window as stale once its reset time has passed', () => {
    expect(isStale(window(90), at('2026-11-16T15:00:01Z'))).toBe(true);
    expect(isStale(window(90), at('2026-11-16T14:59:59Z'))).toBe(false);
    expect(isStale(null, 0)).toBe(false);
  });
});

describe('burnRate and formatting', () => {
  it('averages fresh tokens over the last hours', () => {
    const now = 10 * HOUR_MS;
    const rows = [row({ hourStartMs: 9 * HOUR_MS, input: 600, cacheRead: 9999 }), row({ hourStartMs: 8 * HOUR_MS, output: 400 }), row({ hourStartMs: 2 * HOUR_MS, input: 5000 })];
    expect(burnRate(rows, now, 2)).toBe(500);
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(28175)).toBe('28k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(34_000_000)).toBe('34M');
  });
});

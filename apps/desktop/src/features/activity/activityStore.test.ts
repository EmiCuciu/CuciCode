import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []), isTauri: () => false }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));

const { kindOfLogLine, newLogLines } = await import('./activityStore.ts');

describe('newLogLines', () => {
  it('returns lines appended since the earlier version', () => {
    expect(newLogLines(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
    expect(newLogLines([], ['a'])).toEqual(['a']);
    expect(newLogLines(['a'], ['a'])).toEqual([]);
  });

  it('copes with the log dropping its oldest lines', () => {
    expect(newLogLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
  });

  it('treats an unrelated log, such as a new run, as all new', () => {
    expect(newLogLines(['old'], ['Planning started.'])).toEqual(['Planning started.']);
  });
});

describe('kindOfLogLine', () => {
  it('sorts pipeline log lines into filterable kinds', () => {
    expect(kindOfLogLine('Plan approved.')).toBe('approval');
    expect(kindOfLogLine('S-001: review requested changes; sent back to the worker (round 1).')).toBe('approval');
    expect(kindOfLogLine('S-001: merged.')).toBe('merge');
    expect(kindOfLogLine('S-002: checks failed; the fix limit is reached.')).toBe('error');
    expect(kindOfLogLine('Planning started.')).toBe('stage');
  });
});

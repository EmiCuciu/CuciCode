import { describe, expect, it } from 'vitest';
import { isUsageLimitText } from './pipeline.ts';

describe('isUsageLimitText', () => {
  it('recognises the message Claude Code returns when the usage window is exhausted', () => {
    expect(isUsageLimitText("You've hit your 5-hour limit · resets 8pm (Europe/Bucharest)")).toBe(true);
    expect(isUsageLimitText('You’ve hit your weekly limit · resets Monday')).toBe(true);
    expect(isUsageLimitText("  you've hit your session limit")).toBe(true);
  });

  it('does not match ordinary work reports that mention limits', () => {
    expect(isUsageLimitText('S-001 is implemented. I added a rate limit check.')).toBe(false);
    expect(isUsageLimitText('The fix limit was reached.\nRESULT: changes_requested')).toBe(false);
    expect(isUsageLimitText('')).toBe(false);
  });
});

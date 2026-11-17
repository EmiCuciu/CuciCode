import { describe, expect, it } from 'vitest';
import { DEFAULT_GUIDANCE, parseGuidance, renderGuidance, rulesPath } from './codeRules.ts';

describe('code rules file', () => {
  it('round-trips the rules through the markdown file', () => {
    const content = renderGuidance(DEFAULT_GUIDANCE);
    expect(content.startsWith('# Code Rules')).toBe(true);
    expect(parseGuidance(content)).toEqual(DEFAULT_GUIDANCE);
  });

  it('reads top-level bullets only, with either marker, and drops empty rules when writing', () => {
    expect(parseGuidance('# Rules\n\nIntro text\n- one\n* two\n    - nested is not a rule\n-not a bullet\n')).toEqual(['one', 'two']);
    expect(renderGuidance(['  spaced   out  ', '', 'b'])).toContain('- spaced out\n- b\n');
  });

  it('builds the path with the separator the project path uses', () => {
    expect(rulesPath('C:\\work\\app')).toBe('C:\\work\\app\\.claude\\rules\\cucicode-code-rules.md');
    expect(rulesPath('/home/me/app/')).toBe('/home/me/app/.claude/rules/cucicode-code-rules.md');
  });
});

import { describe, expect, it } from 'vitest';
import type { ResolvedSetting } from '../../bridge/types.ts';
import { effectiveDefault, HOOK_TIMEOUT_SECONDS, schemaDefaultText, unsetText, type DefaultsInput } from './effectiveDefaults.ts';

const setting = (key: string, value: unknown): ResolvedSetting => ({ key, value, scope: 'user', path: '~/.claude/settings.json', mergedFrom: ['user'] });
const base: DefaultsInput = { resolved: [], init: null, overridden: {}, defaultModel: null };
const init = { model: 'claude-fable-5-2', effort: 'medium', permissionMode: 'default', outputStyle: 'Concise' };

describe('effectiveDefault', () => {
  it('prefers the effective Claude Code setting and names its scope and file', () => {
    const result = effectiveDefault('model', { ...base, resolved: [setting('model', 'opus')], init });
    expect(result).toEqual({ value: 'opus', source: 'user setting, ~/.claude/settings.json' });
    expect(effectiveDefault('effort', { ...base, resolved: [setting('effortLevel', 'high')] }).value).toBe('high');
    expect(effectiveDefault('permissionMode', { ...base, resolved: [setting('permissions.defaultMode', 'acceptEdits')] }).value).toBe('acceptEdits');
  });

  it('falls back to what the session reports, but not for a value the user overrode', () => {
    expect(effectiveDefault('outputStyle', { ...base, init }).value).toBe('Concise');
    expect(effectiveDefault('effort', { ...base, init, overridden: { effort: true } }).value).toBe("the model's default effort");
    expect(effectiveDefault('model', { ...base, init, defaultModel: 'claude-sonnet-5-5', overridden: { model: true } }).value).toBe('claude-sonnet-5-5');
  });

  it('uses documented defaults, built-ins and plain words when nothing is known', () => {
    expect(effectiveDefault('permissionMode', base)).toEqual({ value: 'default', source: 'Claude Code built-in' });
    expect(effectiveDefault('model', base).value).toBe("your account's default model");
    expect(effectiveDefault('outputStyle', base).source).toBe('not set in any settings file');
  });

  it('reads documented defaults from the settings schema', () => {
    expect(schemaDefaultText('includeCoAuthoredBy')).toBe('true');
    expect(schemaDefaultText('model')).toBeNull();
    expect(unsetText('includeCoAuthoredBy')).toBe('Default: true.');
    expect(unsetText('model')).toContain('account');
    expect(unsetText('someUnknownKey')).toContain('No documented default');
  });

  it('knows the documented hook timeouts', () => {
    expect(HOOK_TIMEOUT_SECONDS).toMatchObject({ command: 600, prompt: 30, agent: 60 });
  });
});

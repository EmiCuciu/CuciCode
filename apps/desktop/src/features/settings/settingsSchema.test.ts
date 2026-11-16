import { describe, expect, it } from 'vitest';
import type { ScopeFile } from '../../bridge/types.ts';
import published from '../../assets/claude-code-settings.schema.json';
import { controlFor, listKeys, parseInput, preview, toInput, type SettingsSchema } from './settingsSchema.ts';

const schema: SettingsSchema = {
  properties: {
    model: { type: 'string', description: 'Model override' },
    effortLevel: { type: 'string', enum: ['low', 'high'] },
    cleanupPeriodDays: { type: 'integer', minimum: 1 },
    includeCoAuthoredBy: { type: 'boolean', description: 'DEPRECATED. Use attribution.' },
    permissions: { type: 'object' },
  },
};
const file = (value: Record<string, unknown>): ScopeFile => ({ scope: 'user', path: 'x', exists: true, writable: true, value });

describe('controlFor', () => {
  it('picks a control from the schema type', () => {
    expect(controlFor(schema.properties.model)).toBe('string');
    expect(controlFor(schema.properties.effortLevel)).toBe('enum');
    expect(controlFor(schema.properties.cleanupPeriodDays)).toBe('number');
    expect(controlFor(schema.properties.includeCoAuthoredBy)).toBe('boolean');
    expect(controlFor(schema.properties.permissions)).toBe('json');
    expect(controlFor(undefined)).toBe('json');
    expect(controlFor({ type: ['string', 'null'] })).toBe('json');
  });
});

describe('listKeys', () => {
  it('merges schema keys with unknown keys found in files, sorted, without $schema', () => {
    const keys = listKeys(schema, [file({ $schema: 'x', zCustom: 1, model: 'opus' })]);
    expect(keys.map((key) => key.key)).toEqual(['cleanupPeriodDays', 'effortLevel', 'includeCoAuthoredBy', 'model', 'permissions', 'zCustom']);
    expect(keys.find((key) => key.key === 'zCustom')).toMatchObject({ inSchema: false, control: 'json' });
    expect(keys.find((key) => key.key === 'includeCoAuthoredBy')?.deprecated).toBe(true);
    expect(keys.find((key) => key.key === 'effortLevel')?.options).toEqual(['low', 'high']);
  });

  it('understands the published schema', () => {
    const keys = listKeys(published as unknown as SettingsSchema, []);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.find((key) => key.key === 'model')?.control).toBe('string');
    expect(keys.find((key) => key.key === 'effortLevel')?.control).toBe('enum');
    expect(keys.find((key) => key.key === 'permissions')?.control).toBe('json');
  });
});

describe('parseInput', () => {
  const key = (name: keyof typeof schema.properties) => listKeys(schema, []).find((entry) => entry.key === name)!;

  it('converts text to the typed value', () => {
    expect(parseInput(key('includeCoAuthoredBy'), 'false')).toEqual({ ok: true, value: false });
    expect(parseInput(key('effortLevel'), 'high')).toEqual({ ok: true, value: 'high' });
    expect(parseInput(key('model'), 'opus')).toEqual({ ok: true, value: 'opus' });
    expect(parseInput(key('cleanupPeriodDays'), '30', schema.properties.cleanupPeriodDays)).toEqual({ ok: true, value: 30 });
    expect(parseInput(key('permissions'), '{"allow":["Read"]}')).toEqual({ ok: true, value: { allow: ['Read'] } });
  });

  it('rejects values the schema does not allow', () => {
    expect(parseInput(key('effortLevel'), 'extreme').ok).toBe(false);
    expect(parseInput(key('cleanupPeriodDays'), '0', schema.properties.cleanupPeriodDays).ok).toBe(false);
    expect(parseInput(key('cleanupPeriodDays'), '1.5', schema.properties.cleanupPeriodDays).ok).toBe(false);
    expect(parseInput(key('cleanupPeriodDays'), 'abc').ok).toBe(false);
    expect(parseInput(key('permissions'), '{broken').ok).toBe(false);
    expect(parseInput(key('model'), '   ').ok).toBe(false);
  });
});

describe('formatting', () => {
  it('round-trips values into inputs and shortens long previews', () => {
    expect(toInput('json', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toInput('boolean', true)).toBe('true');
    expect(toInput('string', undefined)).toBe('');
    expect(preview('short')).toBe('short');
    expect(preview({ allow: ['x'.repeat(80)] }).endsWith('…')).toBe(true);
  });
});

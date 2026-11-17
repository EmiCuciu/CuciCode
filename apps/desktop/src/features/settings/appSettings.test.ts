import { describe, expect, it } from 'vitest';
import { defaultAppSettings, resolveAppSettings } from './appSettings';

const resolve = (timestamps: Record<string, unknown>) =>
  resolveAppSettings({ chat: { timestamps } }).chat.timestamps;
const defaults = defaultAppSettings().chat.timestamps;

describe('resolveAppSettings', () => {
  it('has the documented defaults', () => {
    expect(defaults).toEqual({
      show: true,
      showResponseTime: true,
      minResponseMs: 1000,
      timeZone: 'Europe/Bucharest',
      hourCycle: 'h23',
      relativeDays: 3,
      dateSeparator: '.',
      dateTimeSeparator: ', ',
      locale: 'en-GB',
    });
  });

  it('resolves missing or non-object input to defaults', () => {
    expect(resolveAppSettings(undefined)).toEqual(defaultAppSettings());
    expect(resolveAppSettings(null)).toEqual(defaultAppSettings());
    expect(resolveAppSettings({ chat: 'x' })).toEqual(defaultAppSettings());
    expect(resolveAppSettings({ other: 1 })).toEqual(defaultAppSettings());
  });

  it('keeps valid overrides', () => {
    const override = {
      show: false,
      showResponseTime: false,
      minResponseMs: 5000,
      timeZone: 'America/New_York',
      hourCycle: 'h12',
      relativeDays: 5,
      dateSeparator: '/',
      dateTimeSeparator: ' - ',
      locale: 'en-US',
    };
    expect(resolve(override)).toEqual(override);
  });

  it('falls back to defaults for wrong types', () => {
    expect(
      resolve({
        show: 'yes',
        showResponseTime: 1,
        minResponseMs: '5',
        timeZone: 3,
        hourCycle: 23,
        relativeDays: null,
        dateSeparator: 1,
        dateTimeSeparator: {},
        locale: [],
      }),
    ).toEqual(defaults);
  });

  it('resolves an invalid time zone to the system setting', () => {
    expect(resolve({ timeZone: 'Not/AZone' }).timeZone).toBe('');
  });

  it('resolves an invalid hour cycle to the system setting', () => {
    expect(resolve({ hourCycle: 'h99' }).hourCycle).toBe('');
  });

  it('resolves an invalid locale to en-GB', () => {
    expect(resolve({ locale: 'not a locale!' }).locale).toBe('en-GB');
    expect(resolve({ locale: '' }).locale).toBe('en-GB');
  });

  it('falls back for separators longer than 3 characters', () => {
    const resolved = resolve({ dateSeparator: '....', dateTimeSeparator: 'abcd' });
    expect(resolved.dateSeparator).toBe('.');
    expect(resolved.dateTimeSeparator).toBe(', ');
    expect(resolve({ dateSeparator: '---' }).dateSeparator).toBe('---');
  });

  it('clamps relativeDays to 0..7', () => {
    expect(resolve({ relativeDays: -2 }).relativeDays).toBe(0);
    expect(resolve({ relativeDays: 99 }).relativeDays).toBe(7);
  });

  it('clamps minResponseMs to 0..60000', () => {
    expect(resolve({ minResponseMs: -5 }).minResponseMs).toBe(0);
    expect(resolve({ minResponseMs: 999_999 }).minResponseMs).toBe(60_000);
  });

  it('ignores unknown keys', () => {
    expect(resolve({ bogus: true })).toEqual(defaults);
  });
});

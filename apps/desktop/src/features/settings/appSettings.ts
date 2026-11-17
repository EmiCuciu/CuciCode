/**
 * App-wide, personal CuciCode settings. Holds the single set of defaults and resolves the raw
 * user settings object into fully valid settings, so a bad value can never reach the UI.
 */
import { ENGLISH_LOCALE, type MessageTimeFormat, type MessageTimeHourCycle } from '../chat/messageTime.ts';

export type AppSettings = {
  chat: {
    timestamps: MessageTimeFormat;
  };
};

const HOUR_CYCLES: readonly string[] = ['h11', 'h12', 'h23', 'h24'];
const MAX_SEPARATOR_LENGTH = 3;
export const MAX_RELATIVE_DAYS = 7;
export const MAX_MIN_RESPONSE_MS = 60_000;

export function defaultAppSettings(): AppSettings {
  return {
    chat: {
      timestamps: {
        show: true,
        showResponseTime: true,
        minResponseMs: 1000,
        timeZone: 'Europe/Bucharest',
        hourCycle: 'h23',
        relativeDays: 3,
        dateSeparator: '.',
        dateTimeSeparator: ', ',
        locale: 'en-GB',
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function resolveClampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveSeparator(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.length > MAX_SEPARATOR_LENGTH ? fallback : value;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(ENGLISH_LOCALE, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return isValidTimeZone(value) ? value : '';
}

function resolveHourCycle(value: unknown, fallback: MessageTimeHourCycle): MessageTimeHourCycle {
  if (typeof value !== 'string') return fallback;
  return HOUR_CYCLES.includes(value) ? (value as MessageTimeHourCycle) : '';
}

function isValidLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length > 0;
  } catch {
    return false;
  }
}

function resolveLocale(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return isValidLocale(value) ? value : fallback;
}

function resolveTimestamps(raw: unknown, defaults: MessageTimeFormat): MessageTimeFormat {
  const source = asRecord(raw);
  return {
    show: resolveBoolean(source.show, defaults.show),
    showResponseTime: resolveBoolean(source.showResponseTime, defaults.showResponseTime),
    minResponseMs: resolveClampedNumber(source.minResponseMs, defaults.minResponseMs, 0, MAX_MIN_RESPONSE_MS),
    timeZone: resolveTimeZone(source.timeZone, defaults.timeZone),
    hourCycle: resolveHourCycle(source.hourCycle, defaults.hourCycle),
    relativeDays: resolveClampedNumber(source.relativeDays, defaults.relativeDays, 0, MAX_RELATIVE_DAYS),
    dateSeparator: resolveSeparator(source.dateSeparator, defaults.dateSeparator),
    dateTimeSeparator: resolveSeparator(source.dateTimeSeparator, defaults.dateTimeSeparator),
    locale: resolveLocale(source.locale, defaults.locale),
  };
}

export function resolveAppSettings(raw: unknown): AppSettings {
  const defaults = defaultAppSettings();
  const chat = asRecord(asRecord(raw).chat);
  return {
    chat: {
      timestamps: resolveTimestamps(chat.timestamps, defaults.chat.timestamps),
    },
  };
}

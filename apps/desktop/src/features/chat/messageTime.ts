/**
 * Pure formatting of chat message times and response durations. The visible label is assembled from
 * numeric Intl parts in a fixed day.month.year order with English wording, so it never depends on a
 * locale; only the hover tooltip uses the configured locale.
 */

export type MessageTimeHourCycle = 'h11' | 'h12' | 'h23' | 'h24' | '';

export type MessageTimeFormat = {
  show: boolean;
  showResponseTime: boolean;
  minResponseMs: number;
  timeZone: string;
  hourCycle: MessageTimeHourCycle;
  relativeDays: number;
  dateSeparator: string;
  dateTimeSeparator: string;
  locale: string;
};

export type FormattedMessageTime = {
  label: string;
  detail: string;
  spokenDetail: string;
  iso: string;
};

export const MESSAGE_TIME_LABELS = {
  yesterday: 'Yesterday',
  daysAgo: (n: number) => `${n} days ago`,
  respondedIn: (duration: string) => `responded in ${duration}`,
  units: { h: 'h', m: 'm', s: 's' },
};

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
export const ENGLISH_LOCALE = 'en-GB';
const ENGINE_MIDNIGHT_HOUR = '24';
const MIDNIGHT_HOUR = '00';

type DateParts = {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  dayPeriod: string;
};

function zoneAndCycleOptions(format: MessageTimeFormat): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = {};
  if (format.timeZone) options.timeZone = format.timeZone;
  if (format.hourCycle) options.hourCycle = format.hourCycle;
  return options;
}

function readParts(ts: number, format: MessageTimeFormat): DateParts {
  const formatter = new Intl.DateTimeFormat(ENGLISH_LOCALE, {
    ...zoneAndCycleOptions(format),
    numberingSystem: 'latn',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts: DateParts = { day: '', month: '', year: '', hour: '', minute: '', dayPeriod: '' };
  for (const part of formatter.formatToParts(ts)) {
    if (part.type in parts) parts[part.type as keyof DateParts] = part.value;
  }
  if (parts.hour === ENGINE_MIDNIGHT_HOUR) parts.hour = MIDNIGHT_HOUR;
  return parts;
}

function dayNumber(parts: DateParts): number {
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / MS_PER_DAY;
}

function timeOfDay(parts: DateParts): string {
  const clock = `${parts.hour}:${parts.minute}`;
  return parts.dayPeriod ? `${clock} ${parts.dayPeriod}` : clock;
}

function datePrefix(
  parts: DateParts,
  nowParts: DateParts,
  daysBefore: number,
  format: MessageTimeFormat,
): string | null {
  if (daysBefore <= 0) return null;
  if (daysBefore === 1 && format.relativeDays >= 1) return MESSAGE_TIME_LABELS.yesterday;
  if (daysBefore <= format.relativeDays) return MESSAGE_TIME_LABELS.daysAgo(daysBefore);
  if (parts.year === nowParts.year) return [parts.day, parts.month].join(format.dateSeparator);
  return [parts.day, parts.month, parts.year].join(format.dateSeparator);
}

function fullDateTime(ts: number, locale: string, format: MessageTimeFormat): string {
  return new Intl.DateTimeFormat(locale, {
    ...zoneAndCycleOptions(format),
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(ts);
}

export function formatMessageTime(
  ts: number | null,
  now: number,
  format: MessageTimeFormat,
): FormattedMessageTime | null {
  if (ts === null || !Number.isFinite(ts)) return null;
  const parts = readParts(ts, format);
  const nowParts = readParts(now, format);
  const daysBefore = dayNumber(nowParts) - dayNumber(parts);
  const prefix = datePrefix(parts, nowParts, daysBefore, format);
  const time = timeOfDay(parts);
  return {
    label: prefix === null ? time : `${prefix}${format.dateTimeSeparator}${time}`,
    detail: fullDateTime(ts, format.locale, format),
    spokenDetail: fullDateTime(ts, ENGLISH_LOCALE, format),
    iso: new Date(ts).toISOString(),
  };
}

export function formatResponseTime(ms: number, format: MessageTimeFormat): string | null {
  if (!Number.isFinite(ms) || ms < format.minResponseMs) return null;
  const totalSeconds = Math.floor(ms / MS_PER_SECOND);
  const { h, m, s } = MESSAGE_TIME_LABELS.units;
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const segments = [
    hours > 0 ? `${hours}${h}` : '',
    minutes > 0 ? `${minutes}${m}` : '',
    seconds > 0 ? `${seconds}${s}` : '',
  ].filter(Boolean);
  const duration = segments.length > 0 ? segments.join(' ') : `0${s}`;
  return MESSAGE_TIME_LABELS.respondedIn(duration);
}

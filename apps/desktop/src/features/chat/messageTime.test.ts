import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TIME_LABELS,
  formatMessageTime,
  formatResponseTime,
  type MessageTimeFormat,
} from './messageTime';

const FORMAT: MessageTimeFormat = {
  show: true,
  showResponseTime: true,
  minResponseMs: 1000,
  timeZone: 'Europe/Bucharest',
  hourCycle: 'h23',
  relativeDays: 3,
  dateSeparator: '.',
  dateTimeSeparator: ', ',
  locale: 'en-GB',
};

const NOW = Date.parse('2025-03-12T10:00:00+02:00');
const MS_PER_DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const labelOf = (ts: number | null, format: MessageTimeFormat = FORMAT, now = NOW) =>
  formatMessageTime(ts, now, format)?.label;

const ROMANIAN_WORDS = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie',
  'septembrie', 'octombrie', 'noiembrie', 'decembrie',
  'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă', 'duminică', 'ieri', 'acum',
];

describe('formatMessageTime labels', () => {
  it('shows the time only for the same day', () => {
    expect(labelOf(at('2025-03-12T09:30:00+02:00'))).toBe('09:30');
  });

  it('shows Yesterday for one day before', () => {
    expect(labelOf(at('2025-03-11T09:30:00+02:00'))).toBe(`${MESSAGE_TIME_LABELS.yesterday}, 09:30`);
  });

  it('shows N days ago up to relativeDays', () => {
    expect(labelOf(at('2025-03-10T09:30:00+02:00'))).toBe('2 days ago, 09:30');
    expect(labelOf(at('2025-03-09T09:30:00+02:00'))).toBe('3 days ago, 09:30');
  });

  it('shows day and month for an older date in the same year', () => {
    expect(labelOf(at('2025-03-08T09:30:00+02:00'))).toBe('08.03, 09:30');
    expect(labelOf(at('2025-01-12T09:30:00+02:00'))).toBe('12.01, 09:30');
  });

  it('shows the year for another year', () => {
    expect(labelOf(at('2024-03-12T09:30:00+02:00'))).toBe('12.03.2024, 09:30');
  });

  it('renders midnight as 00:00', () => {
    expect(labelOf(at('2025-03-12T00:00:00+02:00'))).toBe('00:00');
    expect(labelOf(at('2025-03-12T00:00:00+02:00'), { ...FORMAT, hourCycle: 'h24' })).toBe('00:00');
  });

  it('follows the configured zone for the day boundary, not UTC', () => {
    const justAfterLocalMidnight = at('2025-03-11T22:30:00Z');
    const now = at('2025-03-12T08:00:00Z');
    expect(labelOf(justAfterLocalMidnight, FORMAT, now)).toBe('00:30');
    expect(labelOf(justAfterLocalMidnight, { ...FORMAT, timeZone: 'UTC' }, now)).toBe('Yesterday, 22:30');
  });

  it('turns relative labels off with relativeDays 0', () => {
    expect(labelOf(at('2025-03-11T09:30:00+02:00'), { ...FORMAT, relativeDays: 0 })).toBe('11.03, 09:30');
  });

  it('gives Yesterday only with relativeDays 1', () => {
    const format = { ...FORMAT, relativeDays: 1 };
    expect(labelOf(at('2025-03-11T09:30:00+02:00'), format)).toBe('Yesterday, 09:30');
    expect(labelOf(at('2025-03-10T09:30:00+02:00'), format)).toBe('10.03, 09:30');
  });

  it('treats a future ts as today', () => {
    expect(labelOf(at('2025-03-14T09:30:00+02:00'))).toBe('09:30');
  });

  it('uses the configured separators', () => {
    const format = { ...FORMAT, dateSeparator: '/', dateTimeSeparator: ' - ' };
    expect(labelOf(at('2024-03-12T09:30:00+02:00'), format)).toBe('12/03/2024 - 09:30');
  });

  it('appends the day period for a 12-hour cycle', () => {
    expect(labelOf(at('2025-03-12T21:30:00+02:00'), { ...FORMAT, hourCycle: 'h12' })).toMatch(/^09:30 pm$/i);
  });

  it('returns null for a null ts', () => {
    expect(formatMessageTime(null, NOW, FORMAT)).toBeNull();
  });

  it('is identical across locales', () => {
    const ts = at('2024-03-12T09:30:00+02:00');
    expect(labelOf(ts, { ...FORMAT, locale: 'ro-RO' })).toBe(labelOf(ts, { ...FORMAT, locale: 'en-US' }));
  });
});

describe('formatMessageTime tooltip', () => {
  it('is the full English date, time and zone', () => {
    const result = formatMessageTime(at('2025-03-12T09:30:00+02:00'), NOW, FORMAT);
    expect(result?.detail).toMatch(/^Wednesday,? 12 March 2025 at 09:30:00 EET$/);
    expect(result?.iso).toBe('2025-03-12T07:30:00.000Z');
  });
});

describe('no Romanian text', () => {
  it('never appears in a label or tooltip for any month or weekday', () => {
    const start = at('2024-01-01T09:30:00+02:00');
    for (let dayIndex = 0; dayIndex < 400; dayIndex += 1) {
      const result = formatMessageTime(start + dayIndex * MS_PER_DAY, NOW, FORMAT);
      const words = `${result?.label} ${result?.detail}`.toLowerCase().split(/[^a-zâăîșț]+/u);
      for (const word of ROMANIAN_WORDS) {
        expect(words).not.toContain(word);
      }
    }
  });
});

describe('formatResponseTime', () => {
  it('returns null below minResponseMs', () => {
    expect(formatResponseTime(999, FORMAT)).toBeNull();
  });

  it('always shows with minResponseMs 0', () => {
    expect(formatResponseTime(0, { ...FORMAT, minResponseMs: 0 })).toBe('responded in 0s');
  });

  it('formats whole units largest first and skips zero units', () => {
    expect(formatResponseTime(45_000, FORMAT)).toBe('responded in 45s');
    expect(formatResponseTime(83_000, FORMAT)).toBe('responded in 1m 23s');
    expect(formatResponseTime(3_725_000, FORMAT)).toBe('responded in 1h 2m 5s');
    expect(formatResponseTime(3_600_000, FORMAT)).toBe('responded in 1h');
  });
});

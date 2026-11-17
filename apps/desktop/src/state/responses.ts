import type { EventCategory } from '@cucicode/protocol';
import type { DisplayEvent, TimelineState } from './timeline.ts';

/**
 * Splits one thread level of a timeline into responses and works out which events carry a
 * timestamp and where a response's total duration belongs. Pure: no formatting, no settings.
 */

export interface ResponseMarks {
  stampIds: ReadonlySet<string>;
  durations: ReadonlyMap<string, number>;
}

const noHiddenCategories: ReadonlySet<EventCategory> = new Set();

function splitIntoSpans(events: DisplayEvent[]): DisplayEvent[][] {
  const spans: DisplayEvent[][] = [];
  let current: DisplayEvent[] = [];
  for (const event of events) {
    if (event.kind === 'user_message' && current.length > 0) {
      spans.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) {
    spans.push(current);
  }
  return spans;
}

function latestTimestamp(span: DisplayEvent[]): number | null {
  return span.reduce<number | null>((latest, event) => (event.ts !== null && (latest === null || event.ts > latest) ? event.ts : latest), null);
}

function mainThreadEnd(span: DisplayEvent[]): number | null {
  const result = span.find((event) => event.kind === 'result');
  return result ? result.ts : latestTimestamp(span);
}

export function responseMarks(
  timeline: TimelineState,
  parentToolUseId: string | null,
  hidden: ReadonlySet<EventCategory> = noHiddenCategories,
): ResponseMarks {
  const levelEvents = timeline.events.filter((event) => event.parentToolUseId === parentToolUseId);
  const spans = splitIntoSpans(levelEvents);
  const stampIds = new Set<string>();
  const durations = new Map<string, number>();
  const parentResult = parentToolUseId === null ? undefined : timeline.results[parentToolUseId];

  spans.forEach((span, index) => {
    const first = span[0];
    if (first?.kind === 'user_message') {
      stampIds.add(first.id);
    }
    const firstText = span.find((event) => event.kind === 'assistant_text');
    if (firstText) {
      stampIds.add(firstText.id);
    }

    const hasLaterUserMessage = index < spans.length - 1;
    const complete = parentToolUseId === null ? hasLaterUserMessage || timeline.runState === 'idle' : parentResult !== undefined;
    const start = first?.kind === 'user_message' ? first.ts : null;
    const end = parentToolUseId === null ? mainThreadEnd(span) : (parentResult?.ts ?? null);
    if (!complete || start === null || end === null || end < start) {
      return;
    }
    const lastVisible = span.findLast((event) => !hidden.has(event.category));
    if (lastVisible) {
      durations.set(lastVisible.id, end - start);
    }
  });

  return { stampIds, durations };
}

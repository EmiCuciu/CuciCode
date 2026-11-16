import { useEffect, useMemo, useRef } from 'react';
import type { EventCategory } from '@cucicode/protocol';
import { selectChat, useApp } from '../../state/store.ts';
import { emptyTimeline } from '../../state/timeline.ts';
import { Composer } from './Composer.tsx';
import { Rows } from './EventRow.tsx';
import { FilterChips } from './FilterChips.tsx';

const NO_HIDDEN: EventCategory[] = [];

export function ChatView({ projectId }: { projectId: string }) {
  const chat = useApp(selectChat(projectId));
  const hiddenList = useApp((state) => state.hiddenCategories[projectId] ?? NO_HIDDEN);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const timeline = chat?.timeline ?? emptyTimeline;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [timeline.events.length, timeline.draft?.text.length]);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <FilterChips projectId={projectId} hidden={hidden} />
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {timeline.events.length === 0 && timeline.draft === null && (
            <div className="mt-16 text-center text-muted">Start a conversation, or pick a session on the right to continue it.</div>
          )}
          <Rows timeline={timeline} parentToolUseId={null} hidden={hidden} />
          {timeline.draft && !hidden.has('thinking') && timeline.draft.thinking && (
            <div className="border-l-2 border-line pl-3 text-muted whitespace-pre-wrap">{timeline.draft.thinking}</div>
          )}
          {timeline.draft && timeline.draft.text && <div className="px-1 py-1 whitespace-pre-wrap">{timeline.draft.text}</div>}
          {timeline.runState !== 'idle' && (
            <div className="font-mono text-[11px] text-muted">
              {timeline.runState === 'requires_action' ? 'waiting for you' : (timeline.status ?? 'working')}…
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <Composer projectId={projectId} chat={chat} />
    </section>
  );
}

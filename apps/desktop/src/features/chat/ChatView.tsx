import { useEffect, useMemo, useRef } from 'react';
import type { EventCategory } from '@cucicode/protocol';
import { selectChat, useApp } from '../../state/store.ts';
import { emptyTimeline } from '../../state/timeline.ts';
import { StoryDiffView } from '../workflow/StoryDiffView.tsx';
import { useWorkflow, workerChatId, type CenterView } from '../workflow/workflowStore.ts';
import { Composer } from './Composer.tsx';
import { Rows } from './EventRow.tsx';
import { FilterChips } from './FilterChips.tsx';

const NO_HIDDEN: EventCategory[] = [];
const MAIN: CenterView = { kind: 'main' };

function ViewTabs({ projectId, view }: { projectId: string; view: CenterView }) {
  const run = useWorkflow((state) => state.projects[projectId]?.run ?? null);
  const worktrees = useWorkflow((state) => state.projects[projectId]?.worktrees);
  const setView = useWorkflow((state) => state.setView);
  const storyIds = useMemo(() => {
    const ids = new Set((worktrees ?? []).map((worktree) => worktree.storyId));
    for (const story of Object.values(run?.stories ?? {})) {
      if (story.stage !== 'queued' && story.stage !== 'merged') {
        ids.add(story.id);
      }
    }
    return [...ids].sort();
  }, [run, worktrees]);
  if (storyIds.length === 0) {
    return null;
  }
  const tab = (active: boolean): string => `rounded px-2 py-1 font-mono text-[12px] ${active ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`;
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1">
      <button type="button" className={tab(view.kind === 'main')} onClick={() => setView(projectId, MAIN)}>
        main thread
      </button>
      {storyIds.map((storyId) => (
        <span key={storyId} className="flex items-center">
          <button type="button" className={tab(view.kind === 'worker' && view.storyId === storyId)} title="The worker's own session, in the story's worktree" onClick={() => setView(projectId, { kind: 'worker', storyId })}>
            {storyId}
          </button>
          <button type="button" className={tab(view.kind === 'diff' && view.storyId === storyId)} title="What this story changed" onClick={() => setView(projectId, { kind: 'diff', storyId })}>
            diff
          </button>
        </span>
      ))}
    </div>
  );
}

function Conversation({ projectId, chatId }: { projectId: string; chatId: string }) {
  const chat = useApp(selectChat(chatId));
  const hiddenList = useApp((state) => state.hiddenCategories[projectId] ?? NO_HIDDEN);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const timeline = chat?.timeline ?? emptyTimeline;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [timeline.events.length, timeline.draft?.text.length]);

  return (
    <>
      <FilterChips projectId={projectId} hidden={hidden} />
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {timeline.events.length === 0 && timeline.draft === null && (
            <div className="mt-16 text-center text-muted">
              {chatId === projectId ? 'Start a conversation, or pick a session on the right to continue it.' : 'This worker has not started in this app session. Its work is in the diff tab.'}
            </div>
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
      <Composer projectId={projectId} chatId={chatId} chat={chat} />
    </>
  );
}

export function ChatView({ projectId }: { projectId: string }) {
  const view = useWorkflow((state) => state.projects[projectId]?.view ?? MAIN);
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <ViewTabs projectId={projectId} view={view} />
      {view.kind === 'diff' ? (
        <StoryDiffView projectId={projectId} storyId={view.storyId} />
      ) : (
        <Conversation key={view.kind === 'worker' ? view.storyId : 'main'} projectId={projectId} chatId={view.kind === 'worker' ? workerChatId(projectId, view.storyId) : projectId} />
      )}
    </section>
  );
}

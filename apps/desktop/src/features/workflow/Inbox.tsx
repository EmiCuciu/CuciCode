import { useMemo, useState } from 'react';
import { useNav } from '../../state/nav.ts';
import { useApp } from '../../state/store.ts';
import { inboxItems, useWorkflow } from './workflowStore.ts';

/** Items waiting for the user: pipeline approvals and failures, and permission requests in any open chat. */
export function Inbox() {
  const projects = useApp((state) => state.projects);
  const chats = useApp((state) => state.chats);
  const selectProject = useApp((state) => state.selectProject);
  const workflows = useWorkflow((state) => state.projects);
  const setView = useWorkflow((state) => state.setView);
  const [open, setOpen] = useState(false);

  const items = useMemo(() => {
    const pipeline = inboxItems(workflows, projects);
    const permissions = Object.entries(chats)
      .filter(([, chat]) => chat.timeline.runState === 'requires_action')
      .map(([chatId]) => {
        const [projectId = chatId, storyId = null] = chatId.split('::');
        const project = projects.find((candidate) => candidate.id === projectId);
        return { projectId, projectName: project?.name ?? projectId, storyId, text: storyId ? `${storyId}: the worker is asking for permission` : 'The main thread is asking for permission' };
      });
    return [...permissions, ...pipeline];
  }, [workflows, projects, chats]);

  const go = (projectId: string, storyId: string | null): void => {
    useNav.getState().go('projects');
    void selectProject(projectId);
    setView(projectId, storyId ? { kind: 'worker', storyId } : { kind: 'main' });
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        className={`rounded border px-2 py-0.5 text-[11px] ${items.length > 0 ? 'border-warn/70 text-warn' : 'border-line text-muted hover:text-fg'}`}
        onClick={() => setOpen(!open)}
      >
        Inbox{items.length > 0 ? ` · ${items.length} waiting for you` : ''}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-96 rounded border border-line bg-panel p-2 shadow-lg">
          {items.length === 0 && <div className="text-muted">Nothing is waiting for you.</div>}
          {items.map((item, index) => (
            <button key={index} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-raised" onClick={() => go(item.projectId, item.storyId)}>
              <div className="font-mono text-[11px] text-muted">{item.projectName}</div>
              <div>{item.text}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

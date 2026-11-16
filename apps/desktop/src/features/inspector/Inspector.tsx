import { useState } from 'react';
import type { SessionSummary } from '@cucicode/protocol';
import { selectChat, useApp } from '../../state/store.ts';
import { totalTokens } from '../../state/timeline.ts';

const NO_SESSIONS: SessionSummary[] = [];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line p-3">
      <div className="mb-2 font-mono text-[11px] tracking-wide text-muted uppercase">{title}</div>
      {children}
    </div>
  );
}

function ContextMeter({ projectId }: { projectId: string }) {
  const chat = useApp(selectChat(projectId));
  const send = useApp((state) => state.send);
  const context = chat?.info?.context ?? null;
  const running = chat !== null && chat.timeline.runState !== 'idle';
  const percentage = context ? Math.min(100, Math.round(context.percentage)) : 0;
  return (
    <Section title="Context">
      <div className="h-2 overflow-hidden rounded bg-raised">
        <div className={`h-full ${percentage > 80 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${percentage}%` }} />
      </div>
      <div className="mt-1 font-mono text-[11px] text-muted">
        {context ? `${context.usedTokens.toLocaleString()} / ${context.maxTokens.toLocaleString()} tokens (${percentage}%)` : 'Known after the first turn'}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={!chat?.open || running} className="rounded border border-line px-2 py-0.5 hover:bg-raised disabled:opacity-40" onClick={() => void send(projectId, '/compact', [], false)}>
          Compact
        </button>
        <button type="button" disabled={!chat?.open || running} className="rounded border border-line px-2 py-0.5 hover:bg-raised disabled:opacity-40" onClick={() => void send(projectId, '/clear', [], false)}>
          Clear
        </button>
      </div>
    </Section>
  );
}

function LastTurn({ projectId }: { projectId: string }) {
  const result = useApp((state) => state.chats[projectId]?.timeline.lastResult ?? null);
  if (!result) {
    return null;
  }
  const tokens = totalTokens(result);
  return (
    <Section title="Last turn">
      <div className="grid grid-cols-2 gap-x-3 font-mono text-[11px]">
        <span className="text-muted">input</span>
        <span>{tokens.input.toLocaleString()}</span>
        <span className="text-muted">output</span>
        <span>{tokens.output.toLocaleString()}</span>
        <span className="text-muted">cache read</span>
        <span>{tokens.cacheRead.toLocaleString()}</span>
        <span className="text-muted">cache write</span>
        <span>{tokens.cacheWrite.toLocaleString()}</span>
      </div>
      <div className="mt-1 text-[11px] text-muted">Includes subagents. Models: {Object.keys(result.modelUsage).join(', ')}</div>
    </Section>
  );
}

function SessionItem({ projectId, session, active }: { projectId: string; session: SessionSummary; active: boolean }) {
  const view = useApp((state) => state.viewSession);
  const rename = useApp((state) => state.renameSession);
  const remove = useApp((state) => state.deleteSession);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(session.title);

  if (editing) {
    return (
      <form
        className="px-3 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) {
            void rename(projectId, session.sessionId, title.trim());
          }
          setEditing(false);
        }}
      >
        <input autoFocus value={title} className="w-full rounded border border-accent bg-bg px-1 py-0.5 outline-none" onChange={(event) => setTitle(event.target.value)} onBlur={() => setEditing(false)} />
      </form>
    );
  }
  return (
    <div className={`group px-3 py-1.5 ${active ? 'bg-raised' : 'hover:bg-raised/50'}`}>
      <button type="button" className="block w-full truncate text-left" title={session.firstPrompt ?? session.title} onClick={() => void view(projectId, session.sessionId)}>
        {session.title || session.firstPrompt || session.sessionId}
      </button>
      <div className="flex gap-2 font-mono text-[11px] text-muted">
        <span>{new Date(session.lastModified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
        {session.gitBranch && <span>{session.gitBranch}</span>}
        <span className="flex-1" />
        {confirming ? (
          <>
            <button type="button" className="text-bad" onClick={() => void remove(projectId, session.sessionId)}>
              delete permanently
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              cancel
            </button>
          </>
        ) : (
          <span className="hidden gap-2 group-hover:flex">
            <button type="button" className="hover:text-fg" onClick={() => setEditing(true)}>
              rename
            </button>
            <button type="button" className="hover:text-bad" onClick={() => setConfirming(true)}>
              delete
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function Sessions({ projectId }: { projectId: string }) {
  const sessions = useApp((state) => state.sessions[projectId] ?? NO_SESSIONS);
  const chat = useApp(selectChat(projectId));
  const newSession = useApp((state) => state.newSession);
  const [search, setSearch] = useState('');
  const currentId = chat?.timeline.init?.sessionId ?? chat?.resumeSessionId ?? null;
  const needle = search.trim().toLowerCase();
  const visible = sessions.filter((session) => `${session.title} ${session.firstPrompt ?? ''}`.toLowerCase().includes(needle));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 p-3 pb-2">
        <span className="font-mono text-[11px] tracking-wide text-muted uppercase">Sessions ({sessions.length})</span>
        <span className="flex-1" />
        <button type="button" className="rounded border border-line px-2 py-0.5 hover:bg-raised" onClick={() => void newSession(projectId)}>
          New
        </button>
      </div>
      <input
        value={search}
        placeholder="Filter by title or first prompt"
        className="mx-3 mb-2 rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent"
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="flex-1 overflow-y-auto">
        {visible.map((session) => (
          <SessionItem key={session.sessionId} projectId={projectId} session={session} active={session.sessionId === currentId} />
        ))}
        {visible.length === 0 && <div className="px-3 text-muted">No sessions.</div>}
      </div>
    </div>
  );
}

export function Inspector({ projectId }: { projectId: string }) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel">
      <ContextMeter projectId={projectId} />
      <LastTurn projectId={projectId} />
      <Sessions projectId={projectId} />
    </aside>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNav } from '../../state/nav.ts';
import { useApp } from '../../state/store.ts';
import { useActivity, type ActivityKind } from './activityStore.ts';

const KINDS: { id: ActivityKind; label: string; tone: string }[] = [
  { id: 'permission', label: 'permissions', tone: 'text-warn' },
  { id: 'approval', label: 'approvals', tone: 'text-accent' },
  { id: 'stage', label: 'stages', tone: 'text-fg' },
  { id: 'merge', label: 'merges', tone: 'text-ok' },
  { id: 'run', label: 'runs', tone: 'text-muted' },
  { id: 'error', label: 'errors', tone: 'text-bad' },
];

function when(ts: number): string {
  const date = new Date(ts);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ActivityView() {
  const entries = useActivity((state) => state.entries);
  const loaded = useActivity((state) => state.loaded);
  const load = useActivity((state) => state.load);
  const projects = useApp((state) => state.projects);
  const selectProject = useApp((state) => state.selectProject);
  const [hidden, setHidden] = useState<Set<ActivityKind>>(new Set());
  const [project, setProject] = useState<string>('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => !hidden.has(entry.kind) && (project === '' || entry.projectId === project) && (needle === '' || entry.text.toLowerCase().includes(needle)));
  }, [entries, hidden, project, search]);

  const toggle = (kind: ActivityKind): void => {
    const next = new Set(hidden);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    setHidden(next);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-semibold">Activity</span>
        {KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-pressed={!hidden.has(kind.id)}
            className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${hidden.has(kind.id) ? 'border-line text-muted line-through' : 'border-accent/60 bg-accent/10 text-fg'}`}
            onClick={() => toggle(kind.id)}
          >
            {kind.label}
          </button>
        ))}
        <select aria-label="Project" className="rounded border border-line bg-panel px-1.5 py-1" value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="">all projects</option>
          {projects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <input value={search} placeholder="Search" className="min-w-32 flex-1 rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent" onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {visible.length === 0 && <div className="mt-8 text-center text-muted">{entries.length === 0 ? 'Nothing has happened yet. Runs, pipeline stages, approvals, merges and errors appear here.' : 'Nothing matches the filters.'}</div>}
        {visible.map((entry, index) => {
          const kind = KINDS.find((candidate) => candidate.id === entry.kind);
          return (
            <div key={`${entry.ts}-${index}`} className="flex items-baseline gap-3 border-b border-line/40 py-1.5">
              <span className="w-24 shrink-0 font-mono text-[11px] text-muted">{when(entry.ts)}</span>
              <span className={`w-20 shrink-0 font-mono text-[11px] ${kind?.tone ?? ''}`}>{entry.kind}</span>
              {entry.projectId ? (
                <button
                  type="button"
                  className="w-32 shrink-0 truncate text-left text-muted hover:text-accent"
                  onClick={() => {
                    useNav.getState().go('projects');
                    void selectProject(entry.projectId ?? '');
                  }}
                >
                  {entry.projectName}
                </button>
              ) : (
                <span className="w-32 shrink-0" />
              )}
              <span className={`min-w-0 flex-1 ${entry.needsUser ? 'text-warn' : ''}`}>{entry.text}</span>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line px-3 py-1 text-[11px] text-muted">
        Kept in ~/.claude/cucicode/activity.local.jsonl (CuciCode's own file). Items that need you also raise a system notification when CuciCode is not in focus.
      </div>
    </section>
  );
}

import { useState } from 'react';
import { useApp } from '../../state/store.ts';

function relativeTime(epochMs: number | null): string {
  if (epochMs === null) {
    return '';
  }
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function ProjectsSidebar() {
  const projects = useApp((state) => state.projects);
  const activeId = useApp((state) => state.activeProjectId);
  const select = useApp((state) => state.selectProject);
  const add = useApp((state) => state.addProject);
  const remove = useApp((state) => state.removeProject);
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const visible = projects.filter((project) => project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle));

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex gap-1 p-2">
        <input
          value={search}
          placeholder="Search projects"
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent"
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="button" title="Add an existing folder" className="rounded border border-line px-2 text-muted hover:text-fg" onClick={() => void add()}>
          +
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 && <div className="p-3 text-muted">{projects.length === 0 ? 'Add a project folder to begin.' : 'No match.'}</div>}
        {visible.map((project) => (
          <div
            key={project.id}
            role="button"
            tabIndex={0}
            onClick={() => void select(project.id)}
            onKeyDown={(event) => event.key === 'Enter' && void select(project.id)}
            className={`group cursor-pointer border-l-2 px-3 py-2 ${project.id === activeId ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised/50'}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="font-mono text-[11px] text-muted">{relativeTime(project.lastActivity)}</span>
              <button
                type="button"
                title="Remove from CuciCode (files are not touched)"
                className="hidden text-muted hover:text-bad group-hover:inline"
                onClick={(event) => {
                  event.stopPropagation();
                  void remove(project.id);
                }}
              >
                ×
              </button>
            </div>
            <div className="flex gap-2 font-mono text-[11px] text-muted">
              {project.branch ? (
                <>
                  <span>{project.branch}</span>
                  <span className={project.dirty ? 'text-warn' : 'text-ok'}>{project.dirty ? 'dirty' : 'clean'}</span>
                </>
              ) : (
                <span>no git</span>
              )}
              {project.remoteHost && <span>{project.remoteHost}</span>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

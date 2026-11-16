import { useEffect, useMemo, useState } from 'react';
import type { ItemKind, ToolkitItem } from '../../bridge/types.ts';
import { useApp } from '../../state/store.ts';
import { ItemDetail } from './ItemDetail.tsx';
import { NewItemWizard } from './NewItemWizard.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { countByKind, filterItems, useToolkit, type ScopeFilter, type ToolkitTab } from './toolkitStore.ts';

const TABS: { id: ToolkitTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'skill', label: 'Skills' },
  { id: 'agent', label: 'Agents' },
  { id: 'mcp', label: 'MCP' },
  { id: 'hook', label: 'Hooks' },
  { id: 'command', label: 'Commands' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'outputStyle', label: 'Output styles' },
  { id: 'rule', label: 'Rules' },
];
const SCOPES: ScopeFilter[] = ['all', 'managed', 'user', 'project', 'local', 'plugin'];
const NO_ITEMS: ToolkitItem[] = [];
const selectClass = 'rounded border border-line bg-panel px-1.5 py-1 text-fg';

function ItemRow({ item, active, onSelect }: { item: ToolkitItem; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className={`block w-full border-l-2 px-3 py-1.5 text-left ${active ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised/50'}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.name}</span>
        {item.conflict && <span className={`font-mono text-[11px] ${item.conflict.wins ? 'text-ok' : 'text-warn'}`}>{item.conflict.wins ? 'wins' : 'overridden'}</span>}
        {item.problem && <span className="font-mono text-[11px] text-bad">invalid</span>}
      </div>
      <div className="flex gap-2 font-mono text-[11px] text-muted">
        <span className="text-accent">{item.kind}</span>
        <span>{item.plugin ? `plugin ${item.plugin}` : item.scope}</span>
        {item.model && <span>{item.model}</span>}
      </div>
      {item.description && <div className="truncate text-[12px] text-muted">{item.description}</div>}
    </button>
  );
}

export function ToolkitView() {
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const { scan, loading, error, tab, scope, search, selectedId, projectPath, load, refresh, setTab, setScope, setSearch, select } = useToolkit();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const active = useApp.getState().projects.find((project) => project.id === activeProjectId);
    void load(active?.path ?? null);
  }, [activeProjectId, load]);

  useEffect(() => {
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const items = scan?.items ?? NO_ITEMS;
  const counts = useMemo(() => countByKind(items), [items]);
  const visible = useMemo(() => filterItems(items, tab, scope, search), [items, tab, scope, search]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const creatableKind: ItemKind = tab === 'all' || tab === 'plugins' || tab === 'hook' || tab === 'mcp' ? 'agent' : tab;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id}
            onClick={() => {
              setTab(entry.id);
              setCreating(false);
            }}
            className={`rounded px-2 py-1 ${tab === entry.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
          >
            {entry.label}
            <span className="ml-1 font-mono text-[11px] text-muted">{entry.id === 'plugins' ? (scan?.plugins.length ?? 0) : (counts[entry.id] ?? 0)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select aria-label="Project" className={selectClass} value={projectPath ?? ''} onChange={(event) => void load(event.target.value || null)}>
          <option value="">Global only (no project)</option>
          {projects.map((project) => (
            <option key={project.id} value={project.path}>
              {project.name}
            </option>
          ))}
        </select>
        <select aria-label="Scope" className={selectClass} value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)}>
          {SCOPES.map((entry) => (
            <option key={entry} value={entry}>
              scope: {entry}
            </option>
          ))}
        </select>
        <input value={search} placeholder="Search name, description, path" className="min-w-40 flex-1 rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent" onChange={(event) => setSearch(event.target.value)} />
        <button type="button" className="rounded border border-line px-2 py-1 text-muted hover:text-fg" onClick={() => void refresh()}>
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
        <button type="button" className="rounded bg-accent/20 px-3 py-1 text-accent" onClick={() => setCreating(true)}>
          New
        </button>
      </div>
      {error && <div className="bg-bad/15 px-3 py-1 text-bad">{error}</div>}
      {creating ? (
        <NewItemWizard initialKind={creatableKind} onClose={() => setCreating(false)} />
      ) : tab === 'plugins' ? (
        <PluginsPanel plugins={scan?.plugins ?? []} marketplaces={scan?.marketplaces ?? []} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 overflow-y-auto border-r border-line">
            {visible.map((item) => (
              <ItemRow key={item.id} item={item} active={item.id === selectedId} onSelect={() => select(item.id)} />
            ))}
            {visible.length === 0 && <div className="p-3 text-muted">{scan ? 'Nothing here at this scope.' : 'Scanning…'}</div>}
          </div>
          {selected ? <ItemDetail key={selected.id} item={selected} all={items} /> : <div className="flex flex-1 items-center justify-center text-muted">Select an item to see its file, scope and conflicts.</div>}
        </div>
      )}
    </section>
  );
}

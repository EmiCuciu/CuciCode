import { create } from 'zustand';
import { mcpApi, toolkitApi, type McpHealth } from '../../bridge/tauri.ts';
import type { ItemKind, ItemScope, ToolkitItem, ToolkitScan } from '../../bridge/types.ts';

export type ToolkitTab = 'all' | ItemKind | 'plugins';
export type ScopeFilter = 'all' | ItemScope;

interface ToolkitState {
  projectPath: string | null;
  scan: ToolkitScan | null;
  loading: boolean;
  error: string | null;
  tab: ToolkitTab;
  scope: ScopeFilter;
  search: string;
  selectedId: string | null;
  health: McpHealth[] | null;
  checkingHealth: boolean;

  checkHealth: () => Promise<void>;
  load: (projectPath: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  setTab: (tab: ToolkitTab) => void;
  setScope: (scope: ScopeFilter) => void;
  setSearch: (search: string) => void;
  select: (id: string | null) => void;
  selectByPath: (path: string) => void;
}

export const useToolkit = create<ToolkitState>((set, get) => ({
  projectPath: null,
  scan: null,
  loading: false,
  error: null,
  tab: 'all',
  scope: 'all',
  search: '',
  selectedId: null,
  health: null,
  checkingHealth: false,

  checkHealth: async () => {
    set({ checkingHealth: true, error: null });
    try {
      set({ health: await mcpApi.health(get().projectPath), checkingHealth: false });
    } catch (error) {
      set({ checkingHealth: false, error: String(error) });
    }
  },
  load: async (projectPath) => {
    const changedProject = projectPath !== get().projectPath || get().scan === null;
    set({ projectPath, loading: true, error: null });
    try {
      if (changedProject) {
        await toolkitApi.watch(projectPath);
      }
      const scan = await toolkitApi.scan(projectPath);
      if (get().projectPath === projectPath) {
        set({ scan, loading: false });
      }
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  refresh: () => get().load(get().projectPath),
  setTab: (tab) => set({ tab }),
  setScope: (scope) => set({ scope }),
  setSearch: (search) => set({ search }),
  select: (selectedId) => set({ selectedId }),
  selectByPath: (path) => {
    const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase();
    const match = get().scan?.items.find((item) => normalize(item.path) === normalize(path));
    set({ selectedId: match?.id ?? null });
  },
}));

export function filterItems(items: ToolkitItem[], tab: ToolkitTab, scope: ScopeFilter, search: string): ToolkitItem[] {
  const needle = search.trim().toLowerCase();
  return items.filter(
    (item) =>
      (tab === 'all' || item.kind === tab) &&
      (scope === 'all' || item.scope === scope) &&
      (needle.length === 0 || `${item.name} ${item.description ?? ''} ${item.relativePath}`.toLowerCase().includes(needle)),
  );
}

export function countByKind(items: ToolkitItem[]): Record<string, number> {
  const counts: Record<string, number> = { all: items.length };
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

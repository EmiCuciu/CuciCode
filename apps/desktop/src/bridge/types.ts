import type { EventCategory } from '@cucicode/protocol';

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  remoteHost: string | null;
  lastActivity: number | null;
}

export type SettingsScope = 'managed' | 'local' | 'project' | 'user';

export interface ResolvedSetting {
  key: string;
  value: unknown;
  scope: SettingsScope;
  path: string;
  mergedFrom: SettingsScope[];
}

export interface ScopeFile {
  scope: SettingsScope;
  path: string;
  exists: boolean;
  writable: boolean;
  value: Record<string, unknown>;
}

export type ItemKind ='agent' | 'skill' | 'command' | 'hook' | 'mcp' | 'outputStyle' | 'rule';
export type ItemScope = 'managed' | 'user' | 'project' | 'local' | 'plugin';

export interface ItemConflict {
  wins: boolean;
  winnerId: string;
  reason: string;
  otherIds: string[];
}

export interface ToolkitItem {
  id: string;
  kind: ItemKind;
  scope: ItemScope;
  name: string;
  description: string | null;
  model: string | null;
  path: string;
  relativePath: string;
  plugin: string | null;
  frontmatter: Record<string, unknown>;
  detail: Record<string, unknown>;
  editable: boolean;
  problem: string | null;
  conflict: ItemConflict | null;
}

export interface PluginInfo {
  id: string;
  name: string;
  marketplace: string | null;
  scope: string;
  version: string | null;
  path: string;
  enabled: boolean;
}

export interface Marketplace {
  name: string;
  source: Record<string, unknown> | null;
  path: string;
  lastUpdated: string | null;
  plugins: { name: string; description: string | null }[];
}

export interface ToolkitScan {
  items: ToolkitItem[];
  plugins: PluginInfo[];
  marketplaces: Marketplace[];
}

export interface ValidationProblem {
  severity: 'error' | 'warning';
  field: string | null;
  message: string;
}

export interface ProjectUiSettings {
  hiddenCategories: EventCategory[];
}

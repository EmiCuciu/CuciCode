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

export interface ProjectUiSettings {
  hiddenCategories: EventCategory[];
}

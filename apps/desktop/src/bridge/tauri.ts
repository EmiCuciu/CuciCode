import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  ChatInfo,
  Method,
  MethodParams,
  SessionSummary,
  TimelineEvent,
} from '@cucicode/protocol';
import type { ItemKind, ItemScope, Project, ProjectUiSettings, ResolvedSetting, ScopeFile, SettingsScope, ToolkitScan, ValidationProblem } from './types.ts';

export const SIDECAR_EVENT = 'sidecar://event';

interface SidecarResults {
  ping: string;
  'chat.open': null;
  'chat.send': null;
  'chat.interrupt': null;
  'chat.setModel': null;
  'chat.setPermissionMode': null;
  'chat.info': ChatInfo;
  'chat.close': null;
  'permission.respond': null;
  'sessions.list': SessionSummary[];
  'sessions.messages': TimelineEvent[];
  'sessions.rename': null;
  'sessions.delete': null;
  'sessions.fork': { sessionId: string };
}

export const inDesktopShell = (): boolean => isTauri();

export function sidecar<M extends Method>(method: M, params: MethodParams<M>): Promise<SidecarResults[M]> {
  return invoke<SidecarResults[M]>('sidecar_request', { method, params });
}

export function onSidecarEvent(handler: (chatId: string, event: TimelineEvent) => void): Promise<UnlistenFn> {
  return listen<{ chatId: string; event: TimelineEvent }>(SIDECAR_EVENT, ({ payload }) => {
    handler(payload.chatId, payload.event);
  });
}

export const projectsApi = {
  list: (): Promise<Project[]> => invoke('projects_list'),
  add: (path: string): Promise<Project> => invoke('projects_add', { path }),
  remove: (id: string): Promise<void> => invoke('projects_remove', { id }),
  pickFolder: async (): Promise<string | null> => {
    const selected = await open({ directory: true, multiple: false, title: 'Add project' });
    return typeof selected === 'string' ? selected : null;
  },
};

export const toolkitApi = {
  scan: (projectPath: string | null): Promise<ToolkitScan> => invoke('toolkit_scan', { projectPath }),
  watch: (projectPath: string | null): Promise<void> => invoke('toolkit_watch', { projectPath }),
  onChanged: (handler: () => void): Promise<UnlistenFn> => listen('toolkit://changed', handler),
  read: (path: string, projectPath: string | null): Promise<string> => invoke('toolkit_read', { path, projectPath }),
  write: (path: string, content: string, projectPath: string | null): Promise<void> => invoke('toolkit_write', { path, content, projectPath }),
  create: (kind: ItemKind, scope: ItemScope, name: string, content: string, projectPath: string | null): Promise<string> =>
    invoke('toolkit_create', { kind, scope, name, content, projectPath }),
  remove: (kind: ItemKind, path: string, projectPath: string | null): Promise<void> => invoke('toolkit_delete', { kind, path, projectPath }),
  copy: (kind: ItemKind, path: string, targetScope: ItemScope, newName: string, removeSource: boolean, projectPath: string | null): Promise<string> =>
    invoke('toolkit_copy', { kind, path, targetScope, newName, removeSource, projectPath }),
  validate: (kind: ItemKind, content: string): Promise<ValidationProblem[]> => invoke('toolkit_validate', { kind, content }),
};

export type CliScope = 'user' | 'project' | 'local';
export type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'update';

export interface McpHealth {
  name: string;
  target: string;
  status: 'connected' | 'needsAuth' | 'failed' | 'unknown';
  detail: string;
}

export const mcpApi = {
  health: (projectPath: string | null): Promise<McpHealth[]> => invoke('mcp_health', { projectPath }),
  add: (scope: CliScope, name: string, config: Record<string, unknown>, projectPath: string | null): Promise<void> => invoke('mcp_add', { scope, name, config, projectPath }),
  remove: (scope: CliScope, name: string, projectPath: string | null): Promise<void> => invoke('mcp_remove', { scope, name, projectPath }),
};

export const pluginApi = {
  act: (action: PluginAction, plugin: string, scope: CliScope, projectPath: string | null): Promise<string> => invoke('plugin_action', { action, plugin, scope, projectPath }),
  addMarketplace: (source: string, scope: CliScope, projectPath: string | null): Promise<string> => invoke('marketplace_add', { source, scope, projectPath }),
  updateMarketplace: (name: string): Promise<string> => invoke('marketplace_update', { name }),
  removeMarketplace: (name: string): Promise<string> => invoke('marketplace_remove', { name }),
};

export const secretsApi = {
  names: (): Promise<string[]> => invoke('secrets_names'),
  set: (name: string, value: string): Promise<void> => invoke('secrets_set', { name, value }),
  remove: (name: string): Promise<void> => invoke('secrets_delete', { name }),
};

export interface VoiceStatus {
  modelReady: boolean;
  recording: boolean;
  modelPath: string;
}

export interface VoiceDownloadProgress {
  received: number;
  total: number | null;
}

export const voiceApi = {
  status: (): Promise<VoiceStatus> => invoke('voice_status'),
  downloadModel: (): Promise<void> => invoke('voice_download_model'),
  start: (): Promise<void> => invoke('voice_start'),
  stop: (): Promise<string> => invoke('voice_stop'),
  onDownloadProgress: (handler: (progress: VoiceDownloadProgress) => void): Promise<UnlistenFn> =>
    listen<VoiceDownloadProgress>('voice://download', ({ payload }) => handler(payload)),
};

export const settingsApi = {
  resolveClaude: (projectPath: string | null): Promise<ResolvedSetting[]> => invoke('claude_settings_resolve', { projectPath }),
  files: (projectPath: string | null): Promise<ScopeFile[]> => invoke('claude_settings_files', { projectPath }),
  setValue: (scope: SettingsScope, projectPath: string | null, key: string, value: unknown): Promise<void> =>
    invoke('claude_settings_set', { scope, projectPath, key, value: value ?? null }),
  getProjectUi: (projectPath: string): Promise<ProjectUiSettings> => invoke('cucicode_project_ui_get', { projectPath }),
  setProjectUi: (projectPath: string, settings: ProjectUiSettings): Promise<void> =>
    invoke('cucicode_project_ui_set', { projectPath, settings }),
};

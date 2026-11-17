import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { create } from 'zustand';
import type { TimelineEvent } from '@cucicode/protocol';
import { chatListeners, useApp } from '../../state/store.ts';

export type ActivityKind = 'run' | 'stage' | 'approval' | 'merge' | 'error' | 'permission';

export interface ActivityEntry {
  ts: number;
  projectId: string | null;
  projectName: string | null;
  kind: ActivityKind;
  text: string;
  needsUser: boolean;
}

interface ActivityState {
  entries: ActivityEntry[];
  loaded: boolean;
  load: () => Promise<void>;
  record: (entry: Omit<ActivityEntry, 'ts' | 'projectName'> & { projectName?: string | null }) => void;
}

const MAX_IN_MEMORY = 1000;

/** Sorts a pipeline log line into a kind, so Activity can be filtered. */
export function kindOfLogLine(line: string): ActivityKind {
  if (/approved|sent back|requested changes/i.test(line)) {
    return 'approval';
  }
  if (/merged|pull request/i.test(line)) {
    return 'merge';
  }
  if (/failed|stopped|limit|could not|no verdict|error/i.test(line)) {
    return 'error';
  }
  return 'stage';
}

/**
 * Lines added to a pipeline log between two versions. The log keeps only its last lines,
 * so new lines are found after the last line the earlier version ended with.
 */
export function newLogLines(before: string[], after: string[]): string[] {
  if (before.length === 0 || after.length === 0) {
    return after;
  }
  if (after.length > before.length && after[before.length - 1] === before[before.length - 1]) {
    return after.slice(before.length);
  }
  const last = before[before.length - 1];
  const index = after.lastIndexOf(last ?? '');
  return index === -1 ? after : after.slice(index + 1);
}

let permissionChecked: Promise<boolean> | null = null;

async function notify(title: string, body: string): Promise<void> {
  if (document.hasFocus()) {
    return;
  }
  permissionChecked ??= isPermissionGranted().then(async (granted) => granted || (await requestPermission()) === 'granted');
  if (await permissionChecked) {
    sendNotification({ title, body });
  }
}

function projectName(projectId: string | null): string | null {
  return projectId === null ? null : (useApp.getState().projects.find((project) => project.id === projectId)?.name ?? projectId);
}

export const useActivity = create<ActivityState>((set, get) => ({
  entries: [],
  loaded: false,

  load: async () => {
    try {
      const entries = await invoke<ActivityEntry[]>('activity_list', { limit: MAX_IN_MEMORY });
      set({ entries, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  record: (partial) => {
    const entry: ActivityEntry = { ...partial, projectName: partial.projectName ?? projectName(partial.projectId), ts: Date.now() };
    set({ entries: [entry, ...get().entries].slice(0, MAX_IN_MEMORY) });
    void invoke('activity_append', { entry }).catch(() => undefined);
    if (entry.needsUser) {
      void notify(entry.projectName ? `CuciCode · ${entry.projectName}` : 'CuciCode', entry.text).catch(() => undefined);
    }
  },
}));

function onChatEvent(chatId: string, event: TimelineEvent): void {
  const [projectId = chatId, storyId] = chatId.split('::');
  const prefix = storyId ? `${storyId}: ` : '';
  const record = useActivity.getState().record;
  if (event.kind === 'permission_request') {
    record({ projectId, kind: 'permission', text: `${prefix}Claude is asking to use ${event.toolName}`, needsUser: true });
  } else if (event.kind === 'result') {
    const seconds = Math.round(event.durationMs / 1000);
    if (event.isError) {
      record({ projectId, kind: 'error', text: `${prefix}Turn stopped (${event.subtype}) after ${seconds}s${event.errors.length > 0 ? `: ${event.errors[0]}` : ''}`, needsUser: false });
    } else {
      record({ projectId, kind: 'run', text: `${prefix}Turn finished in ${seconds}s (${event.numTurns} model call${event.numTurns === 1 ? '' : 's'})`, needsUser: false });
    }
  }
}

chatListeners.add(onChatEvent);

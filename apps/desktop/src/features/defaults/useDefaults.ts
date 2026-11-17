import { useEffect, useState } from 'react';
import { settingsApi } from '../../bridge/tauri.ts';
import type { ResolvedSetting } from '../../bridge/types.ts';
import { useApp } from '../../state/store.ts';
import { effectiveDefault, type DefaultKey, type DefaultValue } from './effectiveDefaults.ts';

/** Effective Claude Code settings for a project (or the user scope), loaded once per project. */
export function useResolvedSettings(projectPath: string | null): ResolvedSetting[] {
  const [resolved, setResolved] = useState<ResolvedSetting[]>([]);
  useEffect(() => {
    let cancelled = false;
    settingsApi
      .resolveClaude(projectPath)
      .then((entries) => !cancelled && setResolved(entries))
      .catch(() => !cancelled && setResolved([]));
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return resolved;
}

/** The default each picker should show for a chat, combining settings files and the live session. */
export function useDefaults(projectPath: string | null, chatId: string | null): (key: DefaultKey) => DefaultValue {
  const resolved = useResolvedSettings(projectPath);
  const chat = useApp((state) => (chatId ? state.chats[chatId] : undefined));
  const defaultModel = chat?.info?.models.find((model) => model.value === 'default')?.resolvedModel ?? null;
  const init = chat?.timeline.init ?? null;
  const overridden = { model: chat?.model !== undefined, effort: chat?.effort !== undefined };
  return (key) => effectiveDefault(key, { resolved, init, overridden, defaultModel });
}

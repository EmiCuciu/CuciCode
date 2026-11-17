/**
 * Shared store of the app-wide, personal settings kept in the user-level CuciCode settings file.
 * It loads once, holds the resolved settings, and persists one section at a time. While loading,
 * and when loading fails, it holds the defaults so the chat always renders.
 */
import { create } from 'zustand';
import { settingsApi } from '../../bridge/tauri.ts';
import { defaultAppSettings, resolveAppSettings, type AppSettings } from './appSettings.ts';

interface AppSettingsState {
  settings: AppSettings;
  raw: Record<string, unknown>;
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  saveSection: (key: string, value: unknown) => Promise<void>;
}

export const useAppSettings = create<AppSettingsState>((set, get) => ({
  settings: defaultAppSettings(),
  raw: {},
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: null });
    try {
      const raw = await settingsApi.getUser();
      set({ raw, settings: resolveAppSettings(raw), loaded: true, loading: false });
    } catch (error) {
      set({ settings: defaultAppSettings(), raw: {}, loaded: true, loading: false, error: String(error) });
    }
  },
  saveSection: async (key, value) => {
    try {
      await settingsApi.setUser(key, value);
      const raw = { ...get().raw, [key]: value };
      set({ raw, settings: resolveAppSettings(raw), error: null });
    } catch (error) {
      set({ error: String(error) });
    }
  },
}));

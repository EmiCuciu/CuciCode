import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from './appSettings.ts';

const getUser = vi.fn();
const setUser = vi.fn();

vi.mock('../../bridge/tauri.ts', () => ({ settingsApi: { getUser, setUser } }));

const { useAppSettings } = await import('./appSettingsStore.ts');

const initialState = useAppSettings.getState();

describe('useAppSettings', () => {
  beforeEach(() => {
    useAppSettings.setState(initialState, true);
    getUser.mockReset();
    setUser.mockReset();
  });

  it('stays unloaded and reports the error when loading fails, then recovers on retry', async () => {
    getUser.mockRejectedValueOnce(new Error('unreadable'));
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().loaded).toBe(false);
    expect(useAppSettings.getState().loadError).toContain('unreadable');
    expect(useAppSettings.getState().settings).toEqual(defaultAppSettings());

    getUser.mockResolvedValueOnce({ chat: { timestamps: { relativeDays: 5 } } });
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().loaded).toBe(true);
    expect(useAppSettings.getState().loadError).toBeNull();
    expect(useAppSettings.getState().settings.chat.timestamps.relativeDays).toBe(5);
  });

  it('reports whether a save succeeded and keeps the failure until cleared', async () => {
    getUser.mockResolvedValueOnce({});
    await useAppSettings.getState().load();

    setUser.mockRejectedValueOnce(new Error('disk full'));
    expect(await useAppSettings.getState().saveSection('chat', {})).toBe(false);
    expect(useAppSettings.getState().saveError).toContain('disk full');
    useAppSettings.getState().clearSaveError();
    expect(useAppSettings.getState().saveError).toBeNull();

    setUser.mockResolvedValueOnce(undefined);
    expect(await useAppSettings.getState().saveSection('chat', { timestamps: { relativeDays: 10 } })).toBe(true);
    expect(useAppSettings.getState().settings.chat.timestamps.relativeDays).toBe(7);
  });
});

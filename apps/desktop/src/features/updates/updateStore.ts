import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';

type UpdatePhase = 'idle' | 'available' | 'installing' | 'failed';

interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  message: string | null;
  checkForUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
}

let pending: Update | null = null;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useUpdates = create<UpdateState>((set) => ({
  phase: 'idle',
  version: null,
  message: null,
  checkForUpdate: async () => {
    try {
      pending = await check();
      set(pending ? { phase: 'available', version: pending.version, message: null } : { phase: 'idle', version: null, message: null });
    } catch (error) {
      pending = null;
      set({ phase: 'idle', version: null, message: describe(error) });
    }
  },
  installUpdate: async () => {
    if (!pending) return;
    set({ phase: 'installing', message: null });
    try {
      await pending.downloadAndInstall();
      await relaunch();
    } catch (error) {
      set({ phase: 'failed', message: describe(error) });
    }
  },
  dismiss: () => set({ phase: 'idle', version: null, message: null }),
}));

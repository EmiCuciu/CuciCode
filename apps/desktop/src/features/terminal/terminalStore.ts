import { create } from 'zustand';

interface TerminalState {
  open: boolean;
  /** Increases each time a new command is requested, so the pane restarts with it. */
  runId: number;
  command: string | null;
  show: (command?: string) => void;
  hide: () => void;
}

export const useTerminal = create<TerminalState>((set, get) => ({
  open: false,
  runId: 0,
  command: null,
  show: (command) => set({ open: true, runId: command === undefined ? get().runId : get().runId + 1, command: command ?? get().command }),
  hide: () => set({ open: false }),
}));

/** Quotes text for PowerShell and POSIX shells alike: single quotes, with embedded quotes doubled or escaped. */
export function shellQuote(text: string, windows: boolean): string {
  return windows ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The command that starts Claude Code in the terminal, optionally resuming a session and running a slash command. */
export function claudeCommand(options: { sessionId?: string | null; slash?: string | null; windows: boolean }): string {
  const parts = ['claude'];
  if (options.sessionId) {
    parts.push('--resume', shellQuote(options.sessionId, options.windows));
  }
  if (options.slash) {
    parts.push(shellQuote(options.slash, options.windows));
  }
  return parts.join(' ');
}

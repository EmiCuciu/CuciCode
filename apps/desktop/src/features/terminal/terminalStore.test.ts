import { describe, expect, it } from 'vitest';
import { claudeCommand, shellQuote, useTerminal } from './terminalStore.ts';

describe('terminal commands', () => {
  it('quotes for PowerShell and POSIX shells', () => {
    expect(shellQuote("it's", true)).toBe("'it''s'");
    expect(shellQuote("it's", false)).toBe("'it'\\''s'");
  });

  it('builds the claude command line', () => {
    expect(claudeCommand({ windows: true })).toBe('claude');
    expect(claudeCommand({ windows: true, sessionId: 'abc-123', slash: '/config' })).toBe("claude --resume 'abc-123' '/config'");
    expect(claudeCommand({ windows: false, slash: '/theme' })).toBe("claude '/theme'");
  });

  it('restarts the pane only when a new command is requested', () => {
    useTerminal.getState().show();
    const first = useTerminal.getState().runId;
    useTerminal.getState().show();
    expect(useTerminal.getState().runId).toBe(first);
    useTerminal.getState().show('claude');
    expect(useTerminal.getState()).toMatchObject({ open: true, runId: first + 1, command: 'claude' });
    useTerminal.getState().hide();
    expect(useTerminal.getState().open).toBe(false);
  });
});

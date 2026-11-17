import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { useTerminal } from './terminalStore.ts';

function themeColors(): { background: string; foreground: string; cursor: string } {
  const style = getComputedStyle(document.documentElement);
  return { background: style.getPropertyValue('--cc-bg').trim(), foreground: style.getPropertyValue('--cc-fg').trim(), cursor: style.getPropertyValue('--cc-accent').trim() };
}

/** A real shell in the project folder: the fallback for anything that needs terminal Claude Code. */
export function TerminalPane({ projectId, cwd }: { projectId: string; cwd: string }) {
  const host = useRef<HTMLDivElement>(null);
  const runId = useTerminal((state) => state.runId);
  const hide = useTerminal((state) => state.hide);
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const id = `term-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const terminal = new Terminal({ fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'Consolas, monospace', fontSize: 13, cursorBlink: true, theme: themeColors(), scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    setExited(undefined);
    setError(null);

    const command = useTerminal.getState().command;
    const output = listen<{ id: string; data: string }>('pty://output', ({ payload }) => payload.id === id && terminal.write(payload.data));
    const exit = listen<{ id: string; code: number | null }>('pty://exit', ({ payload }) => payload.id === id && setExited(payload.code));
    const input = terminal.onData((data) => void invoke('pty_write', { id, data }).catch(() => undefined));
    const resize = terminal.onResize(({ cols, rows }) => void invoke('pty_resize', { id, cols, rows }).catch(() => undefined));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);

    void Promise.all([output, exit])
      .then(() => invoke('pty_open', { id, cwd, cols: terminal.cols, rows: terminal.rows, command }))
      .then(() => terminal.focus())
      .catch((reason: unknown) => setError(String(reason)));

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      void output.then((stop) => stop());
      void exit.then((stop) => stop());
      void invoke('pty_close', { id }).catch(() => undefined);
      terminal.dispose();
    };
  }, [id, cwd, runId]);

  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-muted">
        <span className="font-mono">terminal · {cwd}</span>
        {exited !== undefined && <span className="text-warn">shell exited{exited !== null ? ` (${exited})` : ''}</span>}
        {error && <span className="text-bad">{error}</span>}
        <span className="flex-1" />
        <button type="button" className="hover:text-fg" onClick={() => useTerminal.getState().show(useTerminal.getState().command ?? '')}>
          restart
        </button>
        <button type="button" className="hover:text-fg" onClick={hide}>
          close
        </button>
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}

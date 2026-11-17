import type { Project } from '../../bridge/types.ts';
import { useEffect, useState } from 'react';
import { usageApi } from '../../bridge/tauri.ts';
import { useNav } from '../../state/nav.ts';
import type { ChatState } from '../../state/store.ts';
import { FIVE_HOURS_MS, isStale, outlook, type ReportedLimits } from '../usage/usageMath.ts';
import { Inbox } from '../workflow/Inbox.tsx';

function formatReset(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The 5-hour window as Claude Code last reported it, re-read every minute and after each turn. */
function ReportedWindow({ refreshKey }: { refreshKey: unknown }) {
  const [limits, setLimits] = useState<ReportedLimits | null>(null);
  useEffect(() => {
    const read = (): void => {
      usageApi
        .limits()
        .then(setLimits)
        .catch(() => setLimits(null));
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [refreshKey]);
  const window = limits?.fiveHour ?? null;
  if (!limits || !window) {
    return <span className="font-mono text-[11px] text-muted">usage window: no data yet</span>;
  }
  if (isStale(window, Date.now())) {
    return <span className="font-mono text-[11px] text-muted">5h window: reset since last check</span>;
  }
  const result = outlook(window, limits.fetchedAtMs, FIVE_HOURS_MS);
  const percent = Math.round(window.utilization);
  const tone = percent >= 100 || result.kind === 'runs_out' ? 'text-bad' : percent >= 80 ? 'text-warn' : 'text-ok';
  const at = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tail = result.kind === 'runs_out' ? `runs out ~${at(result.runsOutAtMs)}` : result.kind === 'fine' || result.kind === 'exhausted' ? `resets ${at(result.resetsAtMs)}` : '';
  return (
    <button
      type="button"
      className={`font-mono text-[11px] ${tone}`}
      title={`Fetched from Anthropic at ${at(limits.fetchedAtMs)}; the run-out time is an estimate. Click for details.`}
      onClick={() => useNav.getState().go('usage')}
    >
      5h window {percent}%{tail ? ` · ${tail}` : ''}
    </button>
  );
}

function UsageIndicator({ chat }: { chat: ChatState | null }) {
  const limit = chat?.timeline.rateLimit;
  if (!limit || limit.status === 'allowed') {
    return <ReportedWindow refreshKey={chat?.timeline.lastResult} />;
  }
  const tone = limit.status === 'rejected' ? 'text-bad' : limit.status === 'allowed_warning' ? 'text-warn' : 'text-ok';
  const parts = [
    limit.window?.replace('_', ' ') ?? 'limit',
    limit.status.replace('_', ' '),
    limit.utilization !== null ? `${Math.round(limit.utilization * 100)}% used` : null,
    limit.resetsAt !== null ? `resets ${formatReset(limit.resetsAt)}` : null,
  ].filter((part) => part !== null);
  return (
    <span className={`font-mono text-[11px] ${tone}`} title="Reported by Claude Code when the limit state changes; not a live meter">
      {parts.join(' · ')}
    </span>
  );
}

export function TopBar({ project, chat, theme, onToggleTheme }: { project: Project | null; chat: ChatState | null; theme: 'dark' | 'light'; onToggleTheme: () => void }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <span className="font-mono font-semibold tracking-tight">CuciCode</span>
      <span className="text-muted">/</span>
      <span className="truncate">{project?.name ?? 'no project'}</span>
      {project?.branch && <span className="font-mono text-[11px] text-muted">{project.branch}</span>}
      <div className="flex-1" />
      <Inbox />
      <UsageIndicator chat={chat} />
      <button type="button" className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg" onClick={onToggleTheme}>
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
    </header>
  );
}

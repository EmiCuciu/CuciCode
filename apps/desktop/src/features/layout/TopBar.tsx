import type { Project } from '../../bridge/types.ts';
import type { ChatState } from '../../state/store.ts';

function formatReset(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function UsageIndicator({ chat }: { chat: ChatState | null }) {
  const limit = chat?.timeline.rateLimit;
  if (!limit) {
    return <span className="font-mono text-[11px] text-muted">usage window: no data yet</span>;
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
      <UsageIndicator chat={chat} />
      <button type="button" className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg" onClick={onToggleTheme}>
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
    </header>
  );
}

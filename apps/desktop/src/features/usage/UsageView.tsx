import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usageApi } from '../../bridge/tauri.ts';
import { useApp } from '../../state/store.ts';
import { ROLE_INFO, ROLES } from '../workflow/config.ts';
import { useWorkflow } from '../workflow/workflowStore.ts';
import {
  attribute,
  burnRate,
  FIVE_HOURS_MS,
  formatTokens,
  HOUR_MS,
  isStale,
  outlook,
  roleOf,
  SEVEN_DAYS_MS,
  since,
  sumBy,
  type Outlook,
  type ReportedLimits,
  type Totals,
  type UsageRow,
  type WindowUsage,
} from './usageMath.ts';

const RANGES = [
  { id: '5h', label: 'Last 5 hours', ms: FIVE_HOURS_MS },
  { id: '24h', label: 'Last 24 hours', ms: 24 * HOUR_MS },
  { id: '7d', label: 'Last 7 days', ms: SEVEN_DAYS_MS },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const REFRESH_MS = 60_000;

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayTime = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function outlookText(result: Outlook, long: boolean): string {
  const when = long ? dayTime : time;
  switch (result.kind) {
    case 'unknown':
      return `No projection: ${result.reason}.`;
    case 'exhausted':
      return `The limit is reached. It resets at ${when(result.resetsAtMs)}.`;
    case 'runs_out':
      return `At this pace the window runs out at ${when(result.runsOutAtMs)}, before it resets at ${when(result.resetsAtMs)}.`;
    case 'fine':
      return `At this pace it lasts until the reset at ${when(result.resetsAtMs)}.`;
  }
}

function Meter({ title, window, fetchedAtMs, windowMs, warnAt }: { title: string; window: WindowUsage | null; fetchedAtMs: number; windowMs: number; warnAt: number }) {
  const stale = isStale(window, Date.now());
  const percent = window ? Math.min(100, Math.round(window.utilization)) : 0;
  const result = outlook(window, fetchedAtMs, windowMs);
  const tone = percent >= 100 || result.kind === 'runs_out' ? 'bg-bad' : percent >= warnAt ? 'bg-warn' : 'bg-accent';
  return (
    <div className="flex-1 rounded border border-line p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{title}</span>
        <span className="flex-1" />
        <span className="font-mono text-lg">{window ? `${percent}%` : '—'}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded bg-raised">
        <div className={`h-full ${stale ? 'bg-muted' : tone}`} style={{ width: `${percent}%` }} />
      </div>
      {stale ? (
        <div className="mt-2 text-muted">This window has reset since Claude Code last checked, so the real figure is lower. It updates on the next message.</div>
      ) : (
        <>
          <div className="mt-2">{outlookText(result, windowMs > FIVE_HOURS_MS)}</div>
          {(result.kind === 'fine' || result.kind === 'runs_out') && <div className="text-[11px] text-muted">Average pace so far: {result.ratePerHour.toFixed(1)}% per hour (estimate).</div>}
        </>
      )}
    </div>
  );
}

function Table({ title, note, totals, label }: { title: string; note?: string; totals: Totals[]; label: (key: string) => ReactNode }) {
  const max = Math.max(1, ...totals.map((total) => total.fresh));
  return (
    <section className="mb-4">
      <h3 className="font-semibold">{title}</h3>
      {note && <p className="mb-1 text-[11px] text-muted">{note}</p>}
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-line text-right text-muted">
            <th className="py-1 pr-3 text-left font-normal">{title.toLowerCase().replace('by ', '')}</th>
            <th className="w-40 py-1 pr-3 font-normal" />
            <th className="py-1 pr-3 font-normal">input</th>
            <th className="py-1 pr-3 font-normal">output</th>
            <th className="py-1 pr-3 font-normal">cache write</th>
            <th className="py-1 pr-3 font-normal">cache read</th>
            <th className="py-1 font-normal">messages</th>
          </tr>
        </thead>
        <tbody>
          {totals.slice(0, 15).map((total) => (
            <tr key={total.key} className="border-b border-line/40 text-right">
              <td className="max-w-xs truncate py-1 pr-3 text-left">{label(total.key)}</td>
              <td className="py-1 pr-3">
                <div className="h-1.5 rounded bg-raised">
                  <div className="h-full rounded bg-accent" style={{ width: `${(total.fresh / max) * 100}%` }} />
                </div>
              </td>
              <td className="py-1 pr-3">{formatTokens(total.input)}</td>
              <td className="py-1 pr-3">{formatTokens(total.output)}</td>
              <td className="py-1 pr-3">{formatTokens(total.cacheWrite)}</td>
              <td className="py-1 pr-3 text-muted">{formatTokens(total.cacheRead)}</td>
              <td className="py-1">{total.messages}</td>
            </tr>
          ))}
          {totals.length === 0 && (
            <tr>
              <td colSpan={7} className="py-2 text-left text-muted">
                No usage in this range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {totals.length > 15 && <div className="text-[11px] text-muted">Showing the top 15 of {totals.length}.</div>}
    </section>
  );
}

export function UsageView() {
  const projects = useApp((state) => state.projects);
  const activeId = useApp((state) => state.activeProjectId);
  const sessions = useApp((state) => state.sessions);
  const config = useWorkflow((state) => (activeId ? state.projects[activeId]?.config : undefined));
  const [limits, setLimits] = useState<ReportedLimits | null>(null);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [range, setRange] = useState<RangeId>('5h');
  const [scope, setScope] = useState<'project' | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const report = await usageApi.report(Date.now() - SEVEN_DAYS_MS);
      setLimits(report.limits);
      setRows(report.rows);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const agentRoles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const role of ROLES) {
      const agent = config?.routing.roles[role].agent ?? ROLE_INFO[role].defaultAgent;
      if (agent) {
        map[agent] = ROLE_INFO[role].label;
      }
      if (ROLE_INFO[role].defaultAgent) {
        map[ROLE_INFO[role].defaultAgent] ??= ROLE_INFO[role].label;
      }
    }
    return map;
  }, [config]);

  const now = Date.now();
  const rangeMs = RANGES.find((entry) => entry.id === range)?.ms ?? FIVE_HOURS_MS;
  const visible = useMemo(() => {
    const inRange = since(rows, now - rangeMs);
    return scope === 'all' || activeId === null ? inRange : inRange.filter((row) => attribute(row.project, projects).projectId === activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rangeMs, scope, activeId, projects]);

  const titles = useMemo(() => new Map(Object.values(sessions).flat().map((session) => [session.sessionId, session.title])), [sessions]);
  const where = (row: UsageRow) => attribute(row.project, projects);
  const warnAt = config?.budget.warnAtPercent ?? 80;
  const fetchedAt = limits?.fetchedAtMs ?? now;

  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">Usage</h1>
        <span className="text-muted">Subscription windows, not money.</span>
        <span className="flex-1" />
        <button type="button" className="rounded border border-line px-2 py-0.5 text-muted hover:text-fg" onClick={() => void load()}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {error && <div className="mb-2 text-bad">{error}</div>}

      <div className="mb-2 flex flex-wrap gap-3">
        <Meter title="5-hour window" window={limits?.fiveHour ?? null} fetchedAtMs={fetchedAt} windowMs={FIVE_HOURS_MS} warnAt={warnAt} />
        <Meter title="Weekly limit" window={limits?.sevenDay ?? null} fetchedAtMs={fetchedAt} windowMs={SEVEN_DAYS_MS} warnAt={warnAt} />
      </div>
      <p className="mb-4 text-[11px] text-muted">
        {limits
          ? `The percentages and reset times were fetched from Anthropic at ${dayTime(limits.fetchedAtMs)} and refresh every minute. If you are signed out or offline, the last figures Claude Code stored are shown instead. `
          : 'No usage figures are available yet; sign in to Claude Code with a Pro, Max or Team login. '}
        The projections are estimates: utilisation divided by the time since the window opened, extended at the same pace. Token counts below are read from session transcripts on this machine, counting each assistant message once.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {RANGES.map((entry) => (
          <button key={entry.id} type="button" aria-pressed={range === entry.id} className={`rounded px-2 py-1 ${range === entry.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`} onClick={() => setRange(entry.id)}>
            {entry.label}
          </button>
        ))}
        <span className="mx-2 text-line">|</span>
        {(['all', 'project'] as const).map((entry) => (
          <button key={entry} type="button" aria-pressed={scope === entry} disabled={entry === 'project' && activeId === null} className={`rounded px-2 py-1 disabled:opacity-40 ${scope === entry ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`} onClick={() => setScope(entry)}>
            {entry === 'all' ? 'All projects' : 'Current project'}
          </button>
        ))}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-muted">burn rate, last hour: {formatTokens(burnRate(rows, now, 1))} fresh tokens/h</span>
      </div>

      <Table title="By model" totals={sumBy(visible, (row) => row.model)} label={(key) => key} />
      <Table
        title="By role"
        note="The main thread, workers in story worktrees, and subagents by the role their agent fills."
        totals={sumBy(visible, (row) => roleOf(row, where(row).storyId, agentRoles))}
        label={(key) => key}
      />
      <Table title="By agent" totals={sumBy(visible, (row) => row.agent)} label={(key) => (key === 'main' ? 'main thread' : key)} />
      <Table title="By project" totals={sumBy(visible, (row) => where(row).name)} label={(key) => key} />
      <Table
        title="By session"
        totals={sumBy(visible, (row) => `${where(row).name}\u0000${row.sessionId}\u0000${where(row).storyId ?? ''}`)}
        label={(key) => {
          const [name = '', sessionId = '', storyId = ''] = key.split('\u0000');
          return (
            <span title={sessionId}>
              {titles.get(sessionId) ?? `${sessionId.slice(0, 8)}…`}
              <span className="text-muted">
                {' '}
                · {name}
                {storyId ? ` · ${storyId}` : ''}
              </span>
            </span>
          );
        }}
      />
      <p className="text-[11px] text-muted">"Cache read" is earlier context being re-read, which counts far less against limits than fresh input; the bars and ordering use input, output and cache writes.</p>
    </section>
  );
}

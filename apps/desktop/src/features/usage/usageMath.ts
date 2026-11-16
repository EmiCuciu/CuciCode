export interface UsageRow {
  project: string;
  sessionId: string;
  agent: string;
  model: string;
  hourStartMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

export interface WindowUsage {
  utilization: number;
  resetsAt: string | null;
}

export interface ReportedLimits {
  fetchedAtMs: number;
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
}

export const HOUR_MS = 3_600_000;
export const FIVE_HOURS_MS = 5 * HOUR_MS;
export const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;
const WORKTREE_MARKER = '--claude-worktrees-';

export interface Totals {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  /** Input, output and cache writes. Cache reads are listed separately because they are a re-read of earlier input. */
  fresh: number;
}

export function sumBy(rows: UsageRow[], keyOf: (row: UsageRow) => string): Totals[] {
  const groups = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    const total = groups.get(key) ?? { key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, fresh: 0 };
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
    total.messages += row.messages;
    total.fresh += row.input + row.output + row.cacheWrite;
    groups.set(key, total);
  }
  return [...groups.values()].sort((left, right) => right.fresh - left.fresh || left.key.localeCompare(right.key));
}

export function since(rows: UsageRow[], startMs: number): UsageRow[] {
  return rows.filter((row) => row.hourStartMs + HOUR_MS > startMs);
}

/**
 * Maps a transcript folder to a registered project. A story's worktree has its own
 * folder (`<project>--claude-worktrees-<story>`), which counts as that project's worker.
 */
export function attribute(folder: string, projects: { id: string; name: string }[]): { projectId: string | null; name: string; storyId: string | null } {
  const lowered = folder.toLowerCase();
  const exact = projects.find((project) => project.id.toLowerCase() === lowered);
  if (exact) {
    return { projectId: exact.id, name: exact.name, storyId: null };
  }
  const parent = projects.find((project) => lowered.startsWith(`${project.id.toLowerCase()}${WORKTREE_MARKER}`));
  if (parent) {
    return { projectId: parent.id, name: parent.name, storyId: folder.slice(parent.id.length + WORKTREE_MARKER.length) };
  }
  return { projectId: null, name: folder, storyId: null };
}

/** The role a row's tokens belong to: the worker for story worktrees, the main thread, or the role whose agent ran. */
export function roleOf(row: UsageRow, storyId: string | null, agentRoles: Record<string, string>): string {
  if (row.agent !== 'main') {
    return agentRoles[row.agent] ?? row.agent;
  }
  return storyId !== null ? 'Worker' : 'Main thread';
}

export type Outlook =
  | { kind: 'unknown'; reason: string }
  | { kind: 'fine'; ratePerHour: number; resetsAtMs: number }
  | { kind: 'runs_out'; ratePerHour: number; resetsAtMs: number; runsOutAtMs: number }
  | { kind: 'exhausted'; resetsAtMs: number };

/**
 * Projects a window forward at its average pace so far: utilisation divided by the time
 * elapsed since the window opened (its reset time minus its length). An estimate.
 */
export function outlook(window: WindowUsage | null, fetchedAtMs: number, windowMs: number): Outlook {
  if (!window) {
    return { kind: 'unknown', reason: 'Claude Code has not reported this window yet' };
  }
  const resetsAtMs = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) {
    return { kind: 'unknown', reason: 'no reset time was reported' };
  }
  if (window.utilization >= 100) {
    return { kind: 'exhausted', resetsAtMs };
  }
  const elapsedMs = fetchedAtMs - (resetsAtMs - windowMs);
  if (elapsedMs <= 0 || window.utilization <= 0) {
    return { kind: 'unknown', reason: 'not enough usage in this window to project from' };
  }
  const ratePerHour = (window.utilization / elapsedMs) * HOUR_MS;
  const runsOutAtMs = fetchedAtMs + ((100 - window.utilization) / ratePerHour) * HOUR_MS;
  return runsOutAtMs < resetsAtMs ? { kind: 'runs_out', ratePerHour, resetsAtMs, runsOutAtMs } : { kind: 'fine', ratePerHour, resetsAtMs };
}

/** A window whose reset time has passed is stale: the real figure is back near zero. */
export function isStale(window: WindowUsage | null, nowMs: number): boolean {
  if (!window || window.resetsAt === null) {
    return false;
  }
  const resetsAtMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs;
}

/** Fresh tokens per hour over the last `hours` hours. */
export function burnRate(rows: UsageRow[], nowMs: number, hours: number): number {
  const recent = since(rows, nowMs - hours * HOUR_MS);
  return recent.reduce((total, row) => total + row.input + row.output + row.cacheWrite, 0) / hours;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

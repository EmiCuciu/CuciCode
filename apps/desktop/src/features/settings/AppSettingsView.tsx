/**
 * Editor for the app-wide CuciCode settings. It works without a project and writes through the
 * app settings store, which validates every value and shows what was actually applied.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { MessageTimeFormat } from '../chat/messageTime.ts';
import { useAppSettings } from './appSettingsStore.ts';

const input = 'rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent';
const SYSTEM_LABEL = 'system';
const HOUR_CYCLE_OPTIONS = ['', 'h11', 'h12', 'h23', 'h24'] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded border border-line p-3">
      <h3 className="font-semibold">{title}</h3>
      {note && <p className="mb-2 text-muted">{note}</p>}
      {children}
    </section>
  );
}

function Row({ label, applied, children }: { label: string; applied?: string; children: ReactNode }) {
  return (
    <label className="mt-2 flex items-center gap-3">
      <span className="w-56 shrink-0">{label}</span>
      {children}
      {applied !== undefined && <span className="font-mono text-[11px] text-muted">applied: {applied === '' ? SYSTEM_LABEL : applied}</span>}
    </label>
  );
}

function TextField({ value, className, onCommit }: { value: string; className: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={`${input} ${className} font-mono text-[12px]`}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      className={`${input} w-28`}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== '') onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function TimestampsCard() {
  const settings = useAppSettings((state) => state.settings.chat.timestamps);
  const raw = useAppSettings((state) => state.raw);
  const saveSection = useAppSettings((state) => state.saveSection);

  const save = (patch: Partial<Record<keyof MessageTimeFormat, unknown>>) => {
    const chat = asRecord(raw.chat);
    void saveSection('chat', { ...chat, timestamps: { ...asRecord(chat.timestamps), ...patch } });
  };

  return (
    <Card title="Chat timestamps" note="Applies to every project, session and chat. Stored in your personal CuciCode settings file.">
      <Row label="Show message times">
        <input type="checkbox" checked={settings.show} onChange={(event) => save({ show: event.target.checked })} />
      </Row>
      <Row label="Show response time">
        <input type="checkbox" checked={settings.showResponseTime} onChange={(event) => save({ showResponseTime: event.target.checked })} />
      </Row>
      <Row label="Hide response time under (ms)">
        <NumberField value={settings.minResponseMs} min={0} max={60000} onCommit={(next) => save({ minResponseMs: next })} />
      </Row>
      <Row label="Time zone" applied={settings.timeZone}>
        <TextField className="w-56" value={settings.timeZone} onCommit={(next) => save({ timeZone: next })} />
      </Row>
      <Row label="Hour cycle" applied={settings.hourCycle}>
        <select className={`${input} w-28 font-mono text-[12px]`} value={settings.hourCycle} onChange={(event) => save({ hourCycle: event.target.value })}>
          {HOUR_CYCLE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === '' ? SYSTEM_LABEL : option}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Relative days (0 to 7)">
        <NumberField value={settings.relativeDays} min={0} max={7} onCommit={(next) => save({ relativeDays: next })} />
      </Row>
      <Row label="Date separator">
        <TextField className="w-20" value={settings.dateSeparator} onCommit={(next) => save({ dateSeparator: next })} />
      </Row>
      <Row label="Date and time separator">
        <TextField className="w-20" value={settings.dateTimeSeparator} onCommit={(next) => save({ dateTimeSeparator: next })} />
      </Row>
      <Row label="Tooltip locale" applied={settings.locale}>
        <TextField className="w-40" value={settings.locale} onCommit={(next) => save({ locale: next })} />
      </Row>
    </Card>
  );
}

export function AppSettingsView() {
  const error = useAppSettings((state) => state.error);
  const loaded = useAppSettings((state) => state.loaded);

  useEffect(() => {
    void useAppSettings.getState().load();
  }, []);

  return (
    <div className="min-w-0 flex-1 overflow-auto p-4">
      {error && <div className="mb-3 rounded bg-bad/15 px-3 py-1 text-bad">{error}</div>}
      {loaded ? <TimestampsCard /> : <div className="text-muted">Loading settings...</div>}
    </div>
  );
}

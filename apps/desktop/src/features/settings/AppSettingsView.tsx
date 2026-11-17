/**
 * Editor for the app-wide CuciCode settings. It works without a project and writes through the
 * app settings store, which validates every value and shows what was actually applied.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageTimeFormat } from '../chat/messageTime.ts';
import { MAX_MIN_RESPONSE_MS, MAX_RELATIVE_DAYS } from './appSettings.ts';
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mt-2 flex items-center gap-3">
      <span className="w-56 shrink-0">{label}</span>
      {children}
    </label>
  );
}

function AppliedHint({ typed, applied }: { typed: string | null; applied: string }) {
  if (typed === null || typed === applied) return null;
  return (
    <span className="font-mono text-[11px] text-muted">
      applied: {applied === '' ? SYSTEM_LABEL : applied}
    </span>
  );
}

function useCommittedDraft(applied: string, onCommit: (next: string) => Promise<boolean>) {
  const clearSaveError = useAppSettings((state) => state.clearSaveError);
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);

  const edit = (next: string) => {
    clearSaveError();
    setTyped(null);
    setDraft(next);
  };
  const commit = async (isCommittable: (value: string) => boolean) => {
    if (draft === null) return;
    if (!isCommittable(draft)) {
      setDraft(null);
      return;
    }
    if (await onCommit(draft)) {
      setTyped(draft);
      setDraft(null);
    }
  };
  return { shown: draft ?? applied, hint: <AppliedHint typed={typed} applied={applied} />, edit, commit };
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.currentTarget.blur();
}

function TextField({ value, className, onCommit }: { value: string; className: string; onCommit: (next: string) => Promise<boolean> }) {
  const field = useCommittedDraft(value, onCommit);
  return (
    <>
      <input
        className={`${input} ${className} font-mono text-[12px]`}
        value={field.shown}
        onChange={(event) => field.edit(event.target.value)}
        onBlur={() => void field.commit(() => true)}
        onKeyDown={blurOnEnter}
      />
      {field.hint}
    </>
  );
}

function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (next: number) => Promise<boolean> }) {
  const field = useCommittedDraft(String(value), (next) => onCommit(Number(next)));
  return (
    <>
      <input
        type="number"
        min={min}
        max={max}
        className={`${input} w-28`}
        value={field.shown}
        onChange={(event) => field.edit(event.target.value)}
        onBlur={() => void field.commit((draft) => draft.trim() !== '')}
        onKeyDown={blurOnEnter}
      />
      {field.hint}
    </>
  );
}

function TimestampsCard() {
  const settings = useAppSettings((state) => state.settings.chat.timestamps);
  const raw = useAppSettings((state) => state.raw);
  const saveSection = useAppSettings((state) => state.saveSection);

  const save = (patch: Partial<Record<keyof MessageTimeFormat, unknown>>): Promise<boolean> => {
    const chat = asRecord(raw.chat);
    return saveSection('chat', { ...chat, timestamps: { ...asRecord(chat.timestamps), ...patch } });
  };

  return (
    <Card title="Chat timestamps" note="Applies to every project, session and chat. Stored in your personal CuciCode settings file.">
      <Row label="Show message times">
        <input type="checkbox" checked={settings.show} onChange={(event) => void save({ show: event.target.checked })} />
      </Row>
      <Row label="Show response time">
        <input type="checkbox" checked={settings.showResponseTime} onChange={(event) => void save({ showResponseTime: event.target.checked })} />
      </Row>
      <Row label="Hide response time under (ms)">
        <NumberField value={settings.minResponseMs} min={0} max={MAX_MIN_RESPONSE_MS} onCommit={(next) => save({ minResponseMs: next })} />
      </Row>
      <Row label="Time zone">
        <TextField className="w-56" value={settings.timeZone} onCommit={(next) => save({ timeZone: next })} />
      </Row>
      <Row label="Hour cycle">
        <select className={`${input} w-28 font-mono text-[12px]`} value={settings.hourCycle} onChange={(event) => void save({ hourCycle: event.target.value })}>
          {HOUR_CYCLE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === '' ? SYSTEM_LABEL : option}
            </option>
          ))}
        </select>
      </Row>
      <Row label={`Relative days (0 to ${MAX_RELATIVE_DAYS})`}>
        <NumberField value={settings.relativeDays} min={0} max={MAX_RELATIVE_DAYS} onCommit={(next) => save({ relativeDays: next })} />
      </Row>
      <Row label="Date separator">
        <TextField className="w-20" value={settings.dateSeparator} onCommit={(next) => save({ dateSeparator: next })} />
      </Row>
      <Row label="Date and time separator">
        <TextField className="w-20" value={settings.dateTimeSeparator} onCommit={(next) => save({ dateTimeSeparator: next })} />
      </Row>
      <Row label="Tooltip locale">
        <TextField className="w-40" value={settings.locale} onCommit={(next) => save({ locale: next })} />
      </Row>
    </Card>
  );
}

export function AppSettingsView() {
  const saveError = useAppSettings((state) => state.saveError);
  const loadError = useAppSettings((state) => state.loadError);
  const loaded = useAppSettings((state) => state.loaded);
  const clearSaveError = useAppSettings((state) => state.clearSaveError);

  useEffect(() => {
    void useAppSettings.getState().load();
  }, []);

  if (loadError) {
    return (
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <div role="alert" className="mb-3 rounded bg-bad/15 px-3 py-1 text-bad">
          Could not load settings: {loadError}
        </div>
        <button className="rounded border border-line px-3 py-1 hover:border-accent" onClick={() => void useAppSettings.getState().load()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 overflow-auto p-4">
      {saveError && (
        <div role="alert" className="mb-3 flex items-center gap-3 rounded bg-bad/15 px-3 py-1 text-bad">
          <span className="flex-1">Could not save settings: {saveError}</span>
          <button className="underline" onClick={clearSaveError}>
            Dismiss
          </button>
        </div>
      )}
      {loaded ? <TimestampsCard /> : <div role="status" className="text-muted">Loading settings...</div>}
    </div>
  );
}

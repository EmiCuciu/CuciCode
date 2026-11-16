import { useState } from 'react';
import { mcpApi, secretsApi, type CliScope } from '../../bridge/tauri.ts';
import { buildMcp, emptyMcpForm, MCP_PRESETS, validateMcp, type KeyValue, type McpForm, type Transport } from './mcp.ts';
import { useToolkit } from './toolkitStore.ts';

const inputClass = 'w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent';
const SCOPE_NOTE: Record<CliScope, string> = {
  local: 'Only you, only this project (stored in ~/.claude.json).',
  project: 'Everyone on this project (stored in .mcp.json, which is usually committed).',
  user: 'You, in every project (stored in ~/.claude.json).',
};

function Pairs({ label, pairs, onChange }: { label: string; pairs: KeyValue[]; onChange: (pairs: KeyValue[]) => void }) {
  const update = (index: number, patch: Partial<KeyValue>): void => onChange(pairs.map((pair, position) => (position === index ? { ...pair, ...patch } : pair)));
  return (
    <div>
      <div className="flex items-center gap-2 text-muted">
        {label}
        <button type="button" className="text-accent" onClick={() => onChange([...pairs, { name: '', value: '', secret: false }])}>
          + add
        </button>
      </div>
      {pairs.map((pair, index) => (
        <div key={index} className="mt-1 flex items-center gap-1">
          <input className={`${inputClass} w-40 shrink-0`} placeholder="name" value={pair.name} onChange={(event) => update(index, { name: event.target.value })} />
          <input className={inputClass} placeholder="value" type={pair.secret ? 'password' : 'text'} value={pair.value} onChange={(event) => update(index, { value: event.target.value })} />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted" title="Store the value in the OS keychain and write only a ${NAME} reference to the config file">
            <input type="checkbox" checked={pair.secret} onChange={(event) => update(index, { secret: event.target.checked })} />
            secret
          </label>
          <button type="button" className="shrink-0 text-muted hover:text-bad" onClick={() => onChange(pairs.filter((_, position) => position !== index))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function McpAddForm({ onClose }: { onClose: () => void }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const [form, setForm] = useState<McpForm>(emptyMcpForm);
  const [scope, setScope] = useState<CliScope>(projectPath ? 'local' : 'user');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const built = buildMcp(form);

  const save = async (): Promise<void> => {
    const problem = validateMcp(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      for (const secret of built.secrets) {
        await secretsApi.set(secret.name, secret.value);
      }
      await mcpApi.add(scope, form.name, built.config, projectPath);
      await refresh();
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-4">
      <div className="flex w-[30rem] shrink-0 flex-col gap-2">
        <h2 className="text-base font-semibold">Add MCP server</h2>
        <label className="block">
          <span className="text-muted">Start from a preset</span>
          <select
            className={inputClass}
            defaultValue=""
            onChange={(event) => {
              const preset = MCP_PRESETS.find((candidate) => candidate.label === event.target.value);
              setForm(preset ? preset.form : emptyMcpForm);
              setNote(preset ? `${preset.note} Check the command or URL against the server's own documentation before saving.` : null);
            }}
          >
            <option value="">(none)</option>
            {MCP_PRESETS.map((preset) => (
              <option key={preset.label}>{preset.label}</option>
            ))}
          </select>
          {note && <span className="text-[11px] text-warn">{note}</span>}
        </label>
        <label className="block">
          <span className="text-muted">Name</span>
          <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className="block">
          <span className="text-muted">Scope</span>
          <select className={inputClass} value={scope} onChange={(event) => setScope(event.target.value as CliScope)}>
            {projectPath && <option value="local">local</option>}
            {projectPath && <option value="project">project</option>}
            <option value="user">user</option>
          </select>
          <span className="text-[11px] text-muted">{SCOPE_NOTE[scope]}</span>
        </label>
        <label className="block">
          <span className="text-muted">Transport</span>
          <select className={inputClass} value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as Transport })}>
            <option value="stdio">stdio — a program started on this machine</option>
            <option value="http">http — a remote server</option>
            <option value="sse">sse — a remote server (older transport)</option>
          </select>
        </label>
        {form.transport === 'stdio' ? (
          <>
            <label className="block">
              <span className="text-muted">Command</span>
              <input className={inputClass} placeholder="npx" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} />
              <span className="text-[11px] text-muted">On Windows, npx servers usually need the command "cmd" with arguments starting "/c npx".</span>
            </label>
            <label className="block">
              <span className="text-muted">Arguments</span>
              <input className={inputClass} placeholder="-y @scope/server-name" value={form.args} onChange={(event) => setForm({ ...form, args: event.target.value })} />
            </label>
            <Pairs label="Environment variables" pairs={form.env} onChange={(env) => setForm({ ...form, env })} />
          </>
        ) : (
          <>
            <label className="block">
              <span className="text-muted">URL</span>
              <input className={inputClass} placeholder="https://…" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
            </label>
            <Pairs label="Headers" pairs={form.headers} onChange={(headers) => setForm({ ...form, headers })} />
          </>
        )}
        {error && <div className="text-bad">{error}</div>}
        <div className="mt-1 flex gap-2">
          <button type="button" disabled={busy} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40" onClick={() => void save()}>
            {busy ? 'Saving…' : 'Add server'}
          </button>
          <button type="button" className="rounded border border-line px-3 py-1" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-muted">What will be written to Claude Code's configuration:</div>
        <pre className="overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px]">{JSON.stringify({ [form.name || 'name']: built.config }, null, 2)}</pre>
        {built.secrets.length > 0 && (
          <div className="rounded border border-line p-2 text-muted">
            Stored in the OS keychain, not in the file: <span className="font-mono text-fg">{built.secrets.map((secret) => secret.name).join(', ')}</span>. CuciCode sets these as environment variables for the sessions it
            starts. To use this server from <span className="font-mono">claude</span> in a terminal, set the same variables there.
          </div>
        )}
      </div>
    </div>
  );
}

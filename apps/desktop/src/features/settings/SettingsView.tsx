import { useCallback, useEffect, useMemo, useState } from 'react';
import published from '../../assets/claude-code-settings.schema.json';
import { settingsApi } from '../../bridge/tauri.ts';
import type { Project, ResolvedSetting, ScopeFile, SettingsScope } from '../../bridge/types.ts';
import { listKeys, parseInput, preview, toInput, type SettingKey, type SettingsSchema } from './settingsSchema.ts';

const schema = published as unknown as SettingsSchema;
const SCOPE_NOTE: Record<SettingsScope, string> = {
  managed: 'Set by your organisation. Always wins and cannot be changed here.',
  local: 'Only you, only this project. Not committed.',
  project: 'Everyone on this project. Committed with the repository.',
  user: 'You, in every project on this machine.',
};

function effectiveFor(key: string, resolved: ResolvedSetting[]): ResolvedSetting[] {
  return resolved.filter((setting) => setting.key === key || setting.key.startsWith(`${key}.`));
}

function Editor({ setting, files, projectPath, onSaved }: { setting: SettingKey; files: ScopeFile[]; projectPath: string | null; onSaved: () => Promise<void> }) {
  const writable = files.filter((file) => file.writable);
  const firstSet = writable.find((file) => setting.key in file.value);
  const [scope, setScope] = useState<SettingsScope>(firstSet?.scope ?? (projectPath ? 'local' : 'user'));
  const file = writable.find((candidate) => candidate.scope === scope);
  const current = file?.value[setting.key];
  const [text, setText] = useState(toInput(setting.control, current));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(toInput(setting.control, current));
    setError(null);
  }, [scope, setting.key, setting.control, current]);

  const save = async (value: unknown): Promise<void> => {
    try {
      await settingsApi.setValue(scope, projectPath, setting.key, value);
      await onSaved();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const submit = (): void => {
    const parsed = parseInput(setting, text, schema.properties[setting.key]);
    if (parsed.ok) {
      void save(parsed.value);
    } else {
      setError(parsed.error);
    }
  };
  const inputClass = 'w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent';

  return (
    <div className="rounded border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span>Write to</span>
        <select className="rounded border border-line bg-panel px-1.5 py-1" value={scope} onChange={(event) => setScope(event.target.value as SettingsScope)}>
          {writable.map((candidate) => (
            <option key={candidate.scope} value={candidate.scope}>
              {candidate.scope}
            </option>
          ))}
        </select>
        <span className="text-muted">{SCOPE_NOTE[scope]}</span>
      </div>
      <div className="mb-2 font-mono text-[11px] break-all text-muted">
        {file?.path}
        {file && !file.exists ? ' (will be created)' : ''}
      </div>
      {setting.control === 'boolean' || setting.control === 'enum' ? (
        <select className={inputClass} value={text} onChange={(event) => setText(event.target.value)}>
          <option value="">(not set in this scope)</option>
          {(setting.control === 'boolean' ? ['true', 'false'] : setting.options).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : setting.control === 'json' ? (
        <textarea rows={10} spellCheck={false} className={inputClass} value={text} placeholder="JSON value" onChange={(event) => setText(event.target.value)} />
      ) : (
        <input className={inputClass} value={text} placeholder="(not set in this scope)" onChange={(event) => setText(event.target.value)} />
      )}
      {error && <div className="mt-1 text-bad">{error}</div>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="rounded bg-accent/20 px-3 py-1 text-accent" onClick={submit}>
          Save to {scope}
        </button>
        <button type="button" disabled={current === undefined} className="rounded border border-line px-3 py-1 disabled:opacity-40" onClick={() => void save(null)}>
          Remove from this scope
        </button>
      </div>
    </div>
  );
}

function Detail({ setting, files, resolved, projectPath, onSaved }: { setting: SettingKey; files: ScopeFile[]; resolved: ResolvedSetting[]; projectPath: string | null; onSaved: () => Promise<void> }) {
  const effective = effectiveFor(setting.key, resolved);
  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-4">
      <h2 className="font-mono text-base">{setting.key}</h2>
      <p className={`mb-3 ${setting.deprecated ? 'text-warn' : 'text-muted'}`}>{setting.description}</p>

      <h3 className="mb-1 font-mono text-[11px] tracking-wide text-muted uppercase">Effective value</h3>
      {effective.length === 0 ? (
        <div className="mb-3 text-muted">Not set at any scope; Claude Code uses its default.</div>
      ) : (
        <table className="mb-3 w-full border-collapse font-mono text-[12px]">
          <tbody>
            {effective.map((row) => (
              <tr key={row.key} className="border-b border-line/50 align-top">
                <td className="py-1 pr-3">{row.key}</td>
                <td className="py-1 pr-3 break-all">{JSON.stringify(row.value)}</td>
                <td className="py-1 pr-3 whitespace-nowrap text-accent" title={row.mergedFrom.length > 1 ? 'Lists are combined across scopes' : row.path}>
                  {row.mergedFrom.length > 1 ? row.mergedFrom.join(' + ') : row.scope}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="mb-1 font-mono text-[11px] tracking-wide text-muted uppercase">Value in each scope (highest precedence first)</h3>
      <table className="mb-3 w-full border-collapse font-mono text-[12px]">
        <tbody>
          {files.map((file) => (
            <tr key={file.scope} className="border-b border-line/50 align-top">
              <td className="w-20 py-1 pr-3 text-accent">{file.scope}</td>
              <td className="py-1 pr-3 break-all">{setting.key in file.value ? JSON.stringify(file.value[setting.key]) : <span className="text-muted">—</span>}</td>
              <td className="py-1 break-all text-muted">{file.path}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Editor key={setting.key} setting={setting} files={files} projectPath={projectPath} onSaved={onSaved} />
    </div>
  );
}

export function SettingsView({ project }: { project: Project | null }) {
  const projectPath = project?.path ?? null;
  const [files, setFiles] = useState<ScopeFile[]>([]);
  const [resolved, setResolved] = useState<ResolvedSetting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextFiles, nextResolved] = await Promise.all([settingsApi.files(projectPath), settingsApi.resolveClaude(projectPath)]);
      setFiles(nextFiles);
      setResolved(nextResolved);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const keys = useMemo(() => listKeys(schema, files), [files]);
  const isSet = useCallback((key: string) => files.some((file) => key in file.value), [files]);
  const needle = search.trim().toLowerCase();
  const visible = keys.filter((setting) => (!onlySet || isSet(setting.key)) && (needle.length === 0 || `${setting.key} ${setting.description}`.toLowerCase().includes(needle)));
  const current = keys.find((setting) => setting.key === selected) ?? null;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-semibold">Claude Code settings</span>
        <span className="text-muted">{project ? `for ${project.name}` : 'user scope only — select a project to edit project settings'}</span>
        <span className="flex-1" />
        <input value={search} placeholder="Search settings" className="w-64 rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent" onChange={(event) => setSearch(event.target.value)} />
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={onlySet} onChange={(event) => setOnlySet(event.target.checked)} />
          only set
        </label>
      </div>
      {error && <div className="bg-bad/15 px-3 py-1 text-bad">{error}</div>}
      <div className="flex min-h-0 flex-1">
        <div className="w-96 shrink-0 overflow-y-auto border-r border-line">
          {visible.map((setting) => {
            const winner = files.find((file) => setting.key in file.value);
            return (
              <button
                key={setting.key}
                type="button"
                onClick={() => setSelected(setting.key)}
                className={`block w-full border-l-2 px-3 py-1 text-left ${setting.key === selected ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised/50'}`}
              >
                <div className="flex items-baseline gap-2 font-mono text-[12px]">
                  <span className={`min-w-0 flex-1 truncate ${setting.deprecated ? 'text-muted line-through' : ''}`}>{setting.key}</span>
                  {winner && <span className="text-[11px] text-accent">{winner.scope}</span>}
                </div>
                {winner && <div className="truncate font-mono text-[11px] text-muted">{preview(winner.value[setting.key])}</div>}
              </button>
            );
          })}
          {visible.length === 0 && <div className="p-3 text-muted">No settings match.</div>}
        </div>
        {current ? (
          <Detail setting={current} files={files} resolved={resolved} projectPath={projectPath} onSaved={load} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-muted">
            Pick a setting. Each one shows its effective value, where that value comes from, and lets you choose the scope to write to. CuciCode writes only to Claude Code's own settings files.
          </div>
        )}
      </div>
    </section>
  );
}

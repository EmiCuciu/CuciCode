import { useState } from 'react';
import { pluginApi, type CliScope, type PluginAction } from '../../bridge/tauri.ts';
import type { Marketplace, PluginInfo } from '../../bridge/types.ts';
import { useToolkit } from './toolkitStore.ts';

function sourceText(source: Marketplace['source']): string {
  if (!source) {
    return '';
  }
  return String(source.repo ?? source.url ?? source.path ?? JSON.stringify(source));
}

const buttonClass = 'rounded border border-line px-2 py-0.5 text-[12px] hover:bg-raised disabled:opacity-40';

export function PluginsPanel({ plugins, marketplaces }: { plugins: PluginInfo[]; marketplaces: Marketplace[] }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<CliScope>('user');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = async (label: string, work: () => Promise<string>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      const output = await work();
      setMessage({ ok: true, text: output.trim().split('\n').pop() || `${label}: done` });
      await refresh();
    } catch (reason) {
      setMessage({ ok: false, text: String(reason) });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };
  const act = (action: PluginAction, plugin: PluginInfo): Promise<void> =>
    run(`${action} ${plugin.id}`, () => pluginApi.act(action, plugin.id, (plugin.scope as CliScope) ?? 'user', projectPath));
  const installed = new Set(plugins.map((plugin) => plugin.id));

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {busy && <div className="mb-2 text-muted">{busy}…</div>}
      {message && <div className={`mb-2 ${message.ok ? 'text-ok' : 'text-bad'}`}>{message.text}</div>}

      <h2 className="mb-2 text-base font-semibold">Installed plugins</h2>
      {plugins.length === 0 && <div className="mb-4 text-muted">No plugins installed. Install one from a marketplace below.</div>}
      {plugins.map((plugin) => (
        <div key={`${plugin.id}:${plugin.path}`} className="mb-2 rounded border border-line p-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono">{plugin.name}</span>
            {plugin.marketplace && <span className="font-mono text-[11px] text-muted">@{plugin.marketplace}</span>}
            <span className={`font-mono text-[11px] ${plugin.enabled ? 'text-ok' : 'text-muted'}`}>{plugin.enabled ? 'enabled' : 'disabled'}</span>
            <span className="font-mono text-[11px] text-muted">
              {plugin.scope}
              {plugin.version ? ` · ${plugin.version}` : ''}
            </span>
            <span className="flex-1" />
            <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void act(plugin.enabled ? 'disable' : 'enable', plugin)}>
              {plugin.enabled ? 'Disable' : 'Enable'}
            </button>
            <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void act('update', plugin)}>
              Update
            </button>
            {confirming === plugin.id ? (
              <button type="button" disabled={busy !== null} className={`${buttonClass} border-bad/60 text-bad`} onClick={() => void act('uninstall', plugin)}>
                Confirm uninstall
              </button>
            ) : (
              <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => setConfirming(plugin.id)}>
                Uninstall
              </button>
            )}
          </div>
          <div className="font-mono text-[11px] break-all text-muted">{plugin.path}</div>
        </div>
      ))}

      <h2 className="mt-4 mb-2 text-base font-semibold">Marketplaces</h2>
      <p className="mb-2 text-muted">A marketplace is a git repository that lists plugins. Adding your team's repository here is how skills and agents are shared across projects.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={source}
          placeholder="owner/repo, or a git URL (GitHub, Bitbucket, any host)"
          className="min-w-72 flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
          onChange={(event) => setSource(event.target.value)}
        />
        <select className="rounded border border-line bg-panel px-1.5 py-1" value={scope} onChange={(event) => setScope(event.target.value as CliScope)} title="Where new marketplaces and plugins are declared">
          <option value="user">user</option>
          {projectPath && <option value="project">project (shared with the team)</option>}
          {projectPath && <option value="local">local</option>}
        </select>
        <button
          type="button"
          disabled={busy !== null || source.trim().length === 0}
          className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40"
          onClick={() => void run('add marketplace', () => pluginApi.addMarketplace(source, scope, projectPath)).then(() => setSource(''))}
        >
          Add marketplace
        </button>
      </div>
      {marketplaces.length === 0 && <div className="text-muted">No marketplaces added.</div>}
      {marketplaces.map((marketplace) => (
        <details key={marketplace.name} className="mb-2 rounded border border-line p-2">
          <summary className="cursor-pointer">
            <span className="font-mono">{marketplace.name}</span>
            <span className="ml-2 font-mono text-[11px] text-muted">
              {sourceText(marketplace.source)} · {marketplace.plugins.length} plugins
              {marketplace.lastUpdated ? ` · updated ${new Date(marketplace.lastUpdated).toLocaleDateString()}` : ''}
            </span>
          </summary>
          <div className="my-2 flex gap-2">
            <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void run(`update ${marketplace.name}`, () => pluginApi.updateMarketplace(marketplace.name))}>
              Update marketplace
            </button>
            {confirming === `market:${marketplace.name}` ? (
              <button type="button" disabled={busy !== null} className={`${buttonClass} border-bad/60 text-bad`} onClick={() => void run(`remove ${marketplace.name}`, () => pluginApi.removeMarketplace(marketplace.name))}>
                Confirm remove
              </button>
            ) : (
              <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => setConfirming(`market:${marketplace.name}`)}>
                Remove marketplace
              </button>
            )}
          </div>
          <div className="grid grid-cols-[220px_1fr_auto] items-baseline gap-x-3 gap-y-1">
            {marketplace.plugins.map((plugin) => {
              const id = `${plugin.name}@${marketplace.name}`;
              return (
                <div key={plugin.name} className="contents">
                  <span className="truncate font-mono text-[12px]">{plugin.name}</span>
                  <span className="truncate text-muted" title={plugin.description ?? ''}>
                    {plugin.description ?? ''}
                  </span>
                  {installed.has(id) ? (
                    <span className="font-mono text-[11px] text-ok">installed</span>
                  ) : (
                    <button type="button" disabled={busy !== null} className={buttonClass} onClick={() => void run(`install ${id}`, () => pluginApi.act('install', id, scope, projectPath))}>
                      Install to {scope}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}

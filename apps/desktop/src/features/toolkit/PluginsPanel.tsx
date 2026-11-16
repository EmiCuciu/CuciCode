import type { Marketplace, PluginInfo } from '../../bridge/types.ts';

function sourceText(source: Marketplace['source']): string {
  if (!source) {
    return '';
  }
  return String(source.repo ?? source.url ?? source.path ?? JSON.stringify(source));
}

export function PluginsPanel({ plugins, marketplaces }: { plugins: PluginInfo[]; marketplaces: Marketplace[] }) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="mb-2 text-base font-semibold">Installed plugins</h2>
      {plugins.length === 0 && <div className="mb-4 text-muted">No plugins installed.</div>}
      {plugins.map((plugin) => (
        <div key={`${plugin.id}:${plugin.path}`} className="mb-2 rounded border border-line p-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono">{plugin.name}</span>
            {plugin.marketplace && <span className="font-mono text-[11px] text-muted">@{plugin.marketplace}</span>}
            <span className={`font-mono text-[11px] ${plugin.enabled ? 'text-ok' : 'text-muted'}`}>{plugin.enabled ? 'enabled' : 'disabled'}</span>
            <span className="font-mono text-[11px] text-muted">
              {plugin.scope}
              {plugin.version ? ` · ${plugin.version}` : ''}
            </span>
          </div>
          <div className="font-mono text-[11px] break-all text-muted">{plugin.path}</div>
        </div>
      ))}

      <h2 className="mt-4 mb-2 text-base font-semibold">Marketplaces</h2>
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
          <div className="mt-2 grid grid-cols-[200px_1fr] gap-x-3 gap-y-0.5">
            {marketplace.plugins.map((plugin) => (
              <div key={plugin.name} className="contents">
                <span className="truncate font-mono text-[12px]">{plugin.name}</span>
                <span className="truncate text-muted">{plugin.description ?? ''}</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

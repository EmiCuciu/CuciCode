import { useEffect, useState } from 'react';
import { settingsApi } from '../../bridge/tauri.ts';
import type { Project, ResolvedSetting } from '../../bridge/types.ts';

export function SettingsView({ project }: { project: Project | null }) {
  const [settings, setSettings] = useState<ResolvedSetting[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      return;
    }
    let cancelled = false;
    settingsApi
      .resolveClaude(project.path)
      .then((resolved) => !cancelled && setSettings(resolved))
      .catch((reason: unknown) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (!project) {
    return <div className="p-6 text-muted">Select a project to see its effective Claude Code settings.</div>;
  }
  return (
    <section className="flex-1 overflow-y-auto p-4">
      <h1 className="mb-1 text-base font-semibold">Effective Claude Code settings</h1>
      <p className="mb-3 text-muted">
        Read from Claude Code's own files for <span className="font-mono">{project.name}</span>. Each value shows the scope that wins and the file it comes from. Editing arrives in Phase 2.
      </p>
      {error && <div className="mb-2 text-bad">{error}</div>}
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1 pr-3 font-normal">key</th>
            <th className="py-1 pr-3 font-normal">value</th>
            <th className="py-1 pr-3 font-normal">scope</th>
            <th className="py-1 font-normal">file</th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => (
            <tr key={setting.key} className="border-b border-line/50 align-top">
              <td className="py-1 pr-3">{setting.key}</td>
              <td className="max-w-md py-1 pr-3 break-all">{JSON.stringify(setting.value)}</td>
              <td className="py-1 pr-3 text-accent">{setting.scope}</td>
              <td className="py-1 break-all text-muted">{setting.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {settings.length === 0 && !error && <div className="mt-3 text-muted">No settings found at any scope.</div>}
    </section>
  );
}

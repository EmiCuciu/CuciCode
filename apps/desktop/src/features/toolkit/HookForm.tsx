import { useState } from 'react';
import { settingsApi } from '../../bridge/tauri.ts';
import type { SettingsScope } from '../../bridge/types.ts';
import { appendHook, HOOK_EVENTS, type HookForm as HookFields } from './hooks.ts';
import { useToolkit } from './toolkitStore.ts';

const inputClass = 'w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent';

export function HookForm({ onClose }: { onClose: () => void }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const [scope, setScope] = useState<SettingsScope>(projectPath ? 'project' : 'user');
  const [fields, setFields] = useState<HookFields>({ event: 'PreToolUse', matcher: '', command: '', timeout: '' });
  const [error, setError] = useState<string | null>(null);
  const event = HOOK_EVENTS.find((candidate) => candidate.event === fields.event);
  const preview = appendHook(undefined, fields);

  const save = async (): Promise<void> => {
    try {
      const files = await settingsApi.files(projectPath);
      const current = files.find((file) => file.scope === scope)?.value.hooks;
      await settingsApi.setValue(scope, projectPath, 'hooks', appendHook(current, fields));
      await refresh();
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-4">
      <div className="flex w-[30rem] shrink-0 flex-col gap-2">
        <h2 className="text-base font-semibold">New hook</h2>
        <p className="text-muted">A hook is a command Claude Code runs by itself at a fixed moment. It is not a suggestion to the model: it always runs.</p>
        <label className="block">
          <span className="text-muted">Event</span>
          <select className={inputClass} value={fields.event} onChange={(change) => setFields({ ...fields, event: change.target.value, matcher: '' })}>
            {HOOK_EVENTS.map((candidate) => (
              <option key={candidate.event}>{candidate.event}</option>
            ))}
          </select>
          <span className="text-[11px] text-muted">{event?.when}</span>
        </label>
        {event?.matcher && (
          <label className="block">
            <span className="text-muted">Matcher</span>
            <input className={inputClass} placeholder={event.matcher} value={fields.matcher} onChange={(change) => setFields({ ...fields, matcher: change.target.value })} />
            <span className="text-[11px] text-muted">Empty matches everything.</span>
          </label>
        )}
        <label className="block">
          <span className="text-muted">Command</span>
          <input className={inputClass} placeholder="path/to/script or a shell command" value={fields.command} onChange={(change) => setFields({ ...fields, command: change.target.value })} />
          <span className="text-[11px] text-muted">Receives the event as JSON on stdin. Exit code 2 blocks the action for events that can block.</span>
        </label>
        <label className="block">
          <span className="text-muted">Timeout in seconds (default: 600 for commands)</span>
          <input className={inputClass} value={fields.timeout} onChange={(change) => setFields({ ...fields, timeout: change.target.value })} />
        </label>
        <label className="block">
          <span className="text-muted">Scope</span>
          <select className={inputClass} value={scope} onChange={(change) => setScope(change.target.value as SettingsScope)}>
            {projectPath && <option value="project">project (.claude/settings.json)</option>}
            {projectPath && <option value="local">local (.claude/settings.local.json)</option>}
            <option value="user">user (~/.claude/settings.json)</option>
          </select>
        </label>
        {error && <div className="text-bad">{error}</div>}
        <div className="mt-1 flex gap-2">
          <button type="button" disabled={fields.command.trim().length === 0} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40" onClick={() => void save()}>
            Add hook
          </button>
          <button type="button" className="rounded border border-line px-3 py-1" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-muted">Added to the "hooks" setting of the chosen scope:</div>
        <pre className="overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px]">{JSON.stringify(preview, null, 2)}</pre>
      </div>
    </div>
  );
}

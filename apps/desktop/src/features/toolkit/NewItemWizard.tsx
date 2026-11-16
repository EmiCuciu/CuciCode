import { useState } from 'react';
import { toolkitApi } from '../../bridge/tauri.ts';
import type { ItemKind, ItemScope } from '../../bridge/types.ts';
import { buildContent, CREATABLE_KINDS, emptyFields, storedKind, type WizardFields } from './templates.ts';
import { useToolkit } from './toolkitStore.ts';

const inputClass = 'w-full rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function NewItemWizard({ initialKind, onClose }: { initialKind: ItemKind; onClose: () => void }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const selectByPath = useToolkit((state) => state.selectByPath);
  const [kind, setKind] = useState<ItemKind>(CREATABLE_KINDS.some((entry) => entry.kind === initialKind) ? initialKind : 'agent');
  const [scope, setScope] = useState<ItemScope>(projectPath ? 'project' : 'user');
  const [fields, setFields] = useState<WizardFields>(emptyFields);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof WizardFields) => (event: React.ChangeEvent<HTMLInputElement>) => setFields({ ...fields, [key]: event.target.value });
  const entry = CREATABLE_KINDS.find((candidate) => candidate.kind === kind);
  const content = buildContent(kind, fields);
  const needsDescription = kind === 'agent' || kind === 'skill' || kind === 'command';
  const ready = fields.name.trim().length > 0 && (!needsDescription || fields.description.trim().length > 0);

  const create = async (): Promise<void> => {
    try {
      const path = await toolkitApi.create(storedKind(kind), scope, fields.name.trim(), content, projectPath);
      await refresh();
      selectByPath(path);
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <div className="flex w-80 shrink-0 flex-col gap-2">
        <h2 className="text-base font-semibold">New item</h2>
        <Row label="Type" hint={entry?.hint}>
          <select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as ItemKind)}>
            {CREATABLE_KINDS.map((candidate) => (
              <option key={candidate.kind} value={candidate.kind}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Scope" hint={scope === 'user' ? 'Available in every project on this machine.' : 'Lives in this project and can be committed for the team.'}>
          <select className={inputClass} value={scope} onChange={(event) => setScope(event.target.value as ItemScope)}>
            {projectPath && <option value="project">project (.claude)</option>}
            <option value="user">user (~/.claude)</option>
          </select>
        </Row>
        <Row label="Name" hint="Letters, digits, - and _.">
          <input className={`${inputClass} font-mono`} value={fields.name} onChange={set('name')} />
        </Row>
        {kind !== 'rule' && (
          <Row label="Description" hint={kind === 'agent' || kind === 'skill' ? 'Claude reads this to decide when to use it; say when, not only what.' : undefined}>
            <input className={inputClass} value={fields.description} onChange={set('description')} />
          </Row>
        )}
        {kind === 'agent' && (
          <Row label="Tools" hint="Comma-separated, e.g. Read, Grep, Glob. Empty inherits all tools.">
            <input className={`${inputClass} font-mono`} value={fields.tools} onChange={set('tools')} />
          </Row>
        )}
        {(kind === 'agent' || kind === 'skill' || kind === 'command') && (
          <Row label="Model" hint="sonnet, opus, haiku, fable, or empty to inherit.">
            <input className={`${inputClass} font-mono`} value={fields.model} onChange={set('model')} />
          </Row>
        )}
        {(kind === 'skill' || kind === 'command') && (
          <Row label="Argument hint" hint="Shown in the / menu, e.g. [issue-number].">
            <input className={`${inputClass} font-mono`} value={fields.argumentHint} onChange={set('argumentHint')} />
          </Row>
        )}
        {kind === 'rule' && (
          <Row label="Paths" hint="Glob, e.g. src/api/**. Empty loads the rule always.">
            <input className={`${inputClass} font-mono`} value={fields.paths} onChange={set('paths')} />
          </Row>
        )}
        {error && <div className="text-bad">{error}</div>}
        <div className="mt-1 flex gap-2">
          <button type="button" disabled={!ready} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40" onClick={() => void create()}>
            Create
          </button>
          <button type="button" className="rounded border border-line px-3 py-1" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 text-muted">Preview — you can edit the file after it is created.</div>
        <pre className="min-h-0 flex-1 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap">{content}</pre>
      </div>
    </div>
  );
}

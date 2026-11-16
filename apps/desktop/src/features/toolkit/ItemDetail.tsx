import { useEffect, useState, type ReactNode } from 'react';
import { mcpApi, settingsApi, toolkitApi, type CliScope } from '../../bridge/tauri.ts';
import type { ItemScope, ToolkitItem, ValidationProblem } from '../../bridge/types.ts';
import { removeHook } from './hooks.ts';
import { useToolkit } from './toolkitStore.ts';

const FILE_KINDS = new Set(['agent', 'skill', 'command', 'outputStyle', 'rule']);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function KindFields({ item }: { item: ToolkitItem }) {
  const detail = item.detail;
  if (item.kind === 'hook') {
    return (
      <>
        <Field label="event">{show(detail.event)}</Field>
        <Field label="matcher">{show(detail.matcher)}</Field>
        <Field label="type">{show(detail.type)}</Field>
        <Field label="runs">{show(detail.run)}</Field>
        <Field label="timeout">{detail.timeout === null || detail.timeout === undefined ? 'default' : `${show(detail.timeout)}s`}</Field>
      </>
    );
  }
  if (item.kind === 'mcp') {
    return (
      <>
        <Field label="transport">{show(detail.transport)}</Field>
        <Field label={detail.url ? 'url' : 'command'}>{item.description ?? '—'}</Field>
        <Field label="env vars">{(detail.envKeys as string[]).join(', ') || '—'}</Field>
        <Field label="headers">{(detail.headerKeys as string[]).join(', ') || '—'}</Field>
      </>
    );
  }
  if (item.kind === 'agent') {
    return (
      <>
        <Field label="model">{item.model ?? 'inherits'}</Field>
        <Field label="tools">{show(item.frontmatter.tools ?? 'all (inherited)')}</Field>
        <Field label="skills">{show(item.frontmatter.skills)}</Field>
      </>
    );
  }
  return item.model ? <Field label="model">{item.model}</Field> : null;
}

function ConflictNote({ item, all }: { item: ToolkitItem; all: ToolkitItem[] }) {
  const select = useToolkit((state) => state.select);
  if (!item.conflict) {
    return null;
  }
  const others = item.conflict.otherIds.map((id) => all.find((candidate) => candidate.id === id)).filter((other) => other !== undefined);
  return (
    <div className={`mb-3 rounded border p-2 ${item.conflict.wins ? 'border-ok/50' : 'border-warn/60'}`}>
      <div className={item.conflict.wins ? 'text-ok' : 'text-warn'}>
        {item.conflict.wins ? 'This one is used.' : 'Overridden — Claude Code does not use this one.'}
      </div>
      <div className="text-muted">{item.conflict.reason}</div>
      <div className="mt-1 flex flex-wrap gap-2">
        {others.map((other) => (
          <button key={other.id} type="button" className="font-mono text-[11px] text-accent hover:underline" onClick={() => select(other.id)}>
            {other.scope}: {other.relativePath}
            {other.id === item.conflict?.winnerId ? ' (wins)' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function Problems({ problems }: { problems: ValidationProblem[] }) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul className="mb-2 flex flex-col gap-0.5">
      {problems.map((problem, index) => (
        <li key={index} className={problem.severity === 'error' ? 'text-bad' : 'text-warn'}>
          {problem.severity}: {problem.message}
        </li>
      ))}
    </ul>
  );
}

function CopyForm({ item, move, onDone }: { item: ToolkitItem; move: boolean; onDone: () => void }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const selectByPath = useToolkit((state) => state.selectByPath);
  const localName = item.plugin ? item.name.slice(item.plugin.length + 1) : item.name;
  const [scope, setScope] = useState<ItemScope>(item.scope === 'user' && projectPath ? 'project' : 'user');
  const [name, setName] = useState(move ? localName : item.scope === 'plugin' ? localName : `${localName}-copy`);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    try {
      const path = await toolkitApi.copy(item.kind, item.path, scope, name.trim(), move, projectPath);
      await refresh();
      selectByPath(path);
      onDone();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="mb-3 rounded border border-line bg-raised p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span>{move ? 'Move to' : 'Copy to'}</span>
        <select className="rounded border border-line bg-panel px-1 py-0.5" value={scope} onChange={(event) => setScope(event.target.value as ItemScope)}>
          <option value="user">user (~/.claude)</option>
          {projectPath && <option value="project">project (.claude)</option>}
        </select>
        <span>as</span>
        <input className="rounded border border-line bg-bg px-1 py-0.5 font-mono" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" className="rounded bg-accent/20 px-2 py-0.5 text-accent" onClick={() => void submit()}>
          {move ? 'Move' : 'Copy'}
        </button>
        <button type="button" className="text-muted" onClick={onDone}>
          cancel
        </button>
      </div>
      {error && <div className="mt-1 text-bad">{error}</div>}
    </div>
  );
}

export function ItemDetail({ item, all }: { item: ToolkitItem; all: ToolkitItem[] }) {
  const projectPath = useToolkit((state) => state.projectPath);
  const refresh = useToolkit((state) => state.refresh);
  const select = useToolkit((state) => state.select);
  const isFile = FILE_KINDS.has(item.kind);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problems, setProblems] = useState<ValidationProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'copy' | 'move' | 'delete'>('view');

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setError(null);
    setProblems([]);
    setMode('view');
    if (!isFile) {
      return;
    }
    toolkitApi
      .read(item.path, projectPath)
      .then((content) => {
        if (!cancelled) {
          setSaved(content);
          setDraft(content);
        }
      })
      .catch((reason: unknown) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [item.id, item.path, projectPath, isFile]);

  useEffect(() => {
    if (!isFile || saved === null) {
      return;
    }
    const timer = setTimeout(() => {
      toolkitApi.validate(item.kind, draft).then(setProblems).catch(() => setProblems([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, isFile, item.kind, saved]);

  const dirty = saved !== null && draft !== saved;
  const hasErrors = problems.some((problem) => problem.severity === 'error');
  const act = async (work: () => Promise<void>): Promise<void> => {
    try {
      setError(null);
      await work();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const save = (): Promise<void> =>
    act(async () => {
      await toolkitApi.write(item.path, draft, projectPath);
      setSaved(draft);
      await refresh();
    });
  const remove = (): Promise<void> =>
    act(async () => {
      if (item.kind === 'mcp') {
        await mcpApi.remove(item.scope as CliScope, item.name, projectPath);
      } else if (item.kind === 'hook' && item.scope !== 'managed' && item.scope !== 'plugin') {
        const files = await settingsApi.files(projectPath);
        const current = files.find((file) => file.scope === item.scope)?.value.hooks;
        const next = removeHook(current, String(item.detail.event), Number(item.detail.groupIndex), Number(item.detail.handlerIndex));
        await settingsApi.setValue(item.scope, projectPath, 'hooks', Object.keys(next).length > 0 ? next : null);
      } else {
        await toolkitApi.remove(item.kind, item.path, projectPath);
      }
      select(null);
      await refresh();
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-mono text-base">{item.name}</h2>
        <span className="rounded bg-raised px-1.5 font-mono text-[11px] text-accent">{item.kind}</span>
        <span className="rounded bg-raised px-1.5 font-mono text-[11px]">{item.plugin ? `plugin ${item.plugin}` : item.scope}</span>
        {!item.editable && <span className="font-mono text-[11px] text-muted">read-only</span>}
      </div>
      {item.description && <p className="mb-3 text-muted">{item.description}</p>}
      <ConflictNote item={item} all={all} />
      {item.problem && <div className="mb-3 text-bad">{item.problem}</div>}
      <dl className="mb-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 font-mono text-[12px]">
        <KindFields item={item} />
        <Field label="relative path">{item.relativePath}</Field>
        <Field label="absolute path">{item.path}</Field>
      </dl>

      {isFile && (
        <div className="mb-2 flex flex-wrap gap-2">
          {item.editable && (
            <button type="button" disabled={!dirty || hasErrors} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40" onClick={() => void save()}>
              Save
            </button>
          )}
          {dirty && (
            <button type="button" className="rounded border border-line px-3 py-1" onClick={() => setDraft(saved ?? '')}>
              Revert
            </button>
          )}
          <button type="button" className="rounded border border-line px-3 py-1" onClick={() => setMode('copy')}>
            Duplicate
          </button>
          {item.editable && (
            <>
              <button type="button" className="rounded border border-line px-3 py-1" onClick={() => setMode('move')}>
                Move to scope
              </button>
              <button type="button" className="rounded border border-bad/60 px-3 py-1 text-bad" onClick={() => setMode('delete')}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {(mode === 'copy' || mode === 'move') && <CopyForm item={item} move={mode === 'move'} onDone={() => setMode('view')} />}
      {mode === 'delete' && (
        <div className="mb-3 rounded border border-bad/60 p-2">
          {item.kind === 'mcp'
            ? `Remove this server from the ${item.scope} scope?`
            : item.kind === 'hook'
              ? 'Remove this hook from its settings file?'
              : `Delete ${item.kind === 'skill' ? 'the whole skill folder' : 'this file'} permanently?`}
          <button type="button" className="ml-3 text-bad" onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className="ml-3 text-muted" onClick={() => setMode('view')}>
            cancel
          </button>
        </div>
      )}
      {error && <div className="mb-2 text-bad">{error}</div>}

      {isFile ? (
        <>
          <Problems problems={problems} />
          <textarea
            value={draft}
            readOnly={!item.editable}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded border border-line bg-bg p-2 font-mono text-[12px] outline-none focus:border-accent"
            onChange={(event) => setDraft(event.target.value)}
          />
        </>
      ) : (
        <>
          {item.editable && mode === 'view' && (
            <div className="mb-2">
              <button type="button" className="rounded border border-bad/60 px-3 py-1 text-bad" onClick={() => setMode('delete')}>
                Remove
              </button>
            </div>
          )}
          <div className="mb-1 text-muted">
            {item.kind === 'hook'
              ? 'Defined in the "hooks" setting of this file. To change it, remove it and add a new one, or edit "hooks" in Settings.'
              : 'Defined in this file. Values of env vars and headers are hidden. To change it, remove it and add it again.'}
          </div>
          <pre className="min-h-0 flex-1 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px]">
            {JSON.stringify(item.kind === 'hook' ? item.detail.handler : item.detail, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

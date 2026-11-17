import { useCallback, useEffect, useState } from 'react';
import { toolkitApi } from '../../bridge/tauri.ts';
import { DEFAULT_GUIDANCE, ENFORCEMENT, parseGuidance, renderGuidance, RULES_NAME, RULES_RELATIVE, rulesPath, type EnforcementKey } from './codeRules.ts';

const input = 'rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent';

export function CodeRulesCard({ projectPath, enforce, onEnforce }: { projectPath: string; enforce: Record<EnforcementKey, boolean>; onEnforce: (next: Record<EnforcementKey, boolean>) => void }) {
  const path = rulesPath(projectPath);
  const [rules, setRules] = useState<string[] | null>(null);
  const [exists, setExists] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    toolkitApi
      .read(path, projectPath)
      .then((content) => {
        setExists(true);
        setRules(parseGuidance(content));
      })
      .catch(() => {
        setExists(false);
        setRules([]);
      });
  }, [path, projectPath]);
  useEffect(load, [load]);

  const save = async (next: string[]): Promise<void> => {
    try {
      const content = renderGuidance(next);
      if (exists) {
        await toolkitApi.write(path, content, projectPath);
      } else {
        await toolkitApi.create('rule', 'project', RULES_NAME, content, projectPath);
      }
      setMessage(null);
      load();
    } catch (reason) {
      setMessage(String(reason));
    }
  };

  return (
    <section className="mb-4 rounded border border-line p-3">
      <h3 className="font-semibold">Code Rules</h3>
      <p className="mb-2 text-muted">
        <b className="font-normal text-fg">Guidance</b> is written to <span className="font-mono">{RULES_RELATIVE}</span>, which Claude Code loads as instructions in every session and the code-rules reviewer checks each diff against.{' '}
        <b className="font-normal text-fg">Enforcement</b> is a hook in the CuciCode plugin that blocks the change, in the app and in the terminal.
      </p>

      <h4 className="mt-2 text-[12px] text-muted uppercase">Guidance</h4>
      {rules === null ? (
        <div className="text-muted">Reading…</div>
      ) : (
        <>
          {!exists && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-muted">No rules file yet.</span>
              <button type="button" className="rounded bg-accent/20 px-2 py-0.5 text-accent" onClick={() => void save(DEFAULT_GUIDANCE)}>
                Create it with the default rules
              </button>
            </div>
          )}
          {rules.map((rule, index) => (
            <div key={`${index}-${rule}`} className="flex items-start gap-2 py-0.5">
              <span className="text-muted">•</span>
              <span className="min-w-0 flex-1">{rule}</span>
              <button type="button" className="text-[11px] text-muted hover:text-bad" onClick={() => void save(rules.filter((_, position) => position !== index))}>
                remove
              </button>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <input className={`${input} min-w-0 flex-1`} placeholder="Add a rule, e.g. Use constructor injection in services" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button
              type="button"
              disabled={draft.trim().length === 0}
              className="rounded border border-line px-2 py-0.5 hover:bg-raised disabled:opacity-40"
              onClick={() => void save([...rules, draft.trim()]).then(() => setDraft(''))}
            >
              Add
            </button>
          </div>
          <p className="mt-1 text-[11px] text-muted">Other text in the file is kept; only its bullet points are listed here. Edit it freely in Toolkit → Rules.</p>
        </>
      )}

      <h4 className="mt-3 text-[12px] text-muted uppercase">Enforcement</h4>
      {ENFORCEMENT.map((entry) => (
        <label key={entry.key} className="flex items-center gap-2 py-0.5">
          <input type="checkbox" checked={enforce[entry.key]} onChange={(event) => onEnforce({ ...enforce, [entry.key]: event.target.checked })} />
          {entry.label}
        </label>
      ))}
      <p className="mt-1 text-[11px] text-muted">Edits to protected paths are blocked as well; the patterns are under Git above. Enforcement needs the CuciCode plugin to be installed.</p>
      {message && <div className="mt-1 text-bad">{message}</div>}
    </section>
  );
}

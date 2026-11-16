import { useEffect, useState } from 'react';
import { workflowApi, type StoryCommit, type StoryDiff } from '../../bridge/tauri.ts';
import { useApp } from '../../state/store.ts';
import { useWorkflow } from './workflowStore.ts';

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'text-muted';
  }
  if (line.startsWith('@@')) {
    return 'text-accent';
  }
  if (line.startsWith('+')) {
    return 'bg-ok/10 text-ok';
  }
  if (line.startsWith('-')) {
    return 'bg-bad/10 text-bad';
  }
  return '';
}

export function StoryDiffView({ projectId, storyId }: { projectId: string; storyId: string }) {
  const path = useApp((state) => state.projects.find((project) => project.id === projectId)?.path ?? null);
  const check = useWorkflow((state) => state.projects[projectId]?.checks[storyId]);
  const [diff, setDiff] = useState<StoryDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [commits, setCommits] = useState<StoryCommit[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const working = useApp((state) => state.chats[`${projectId}::${storyId}`]?.timeline.runState === 'running');

  const rewindTo = async (sha: string): Promise<void> => {
    if (path === null) {
      return;
    }
    try {
      await workflowApi.resetStory(path, storyId, sha);
      setConfirming(null);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => {
    if (path === null) {
      return;
    }
    let cancelled = false;
    setError(null);
    workflowApi
      .diff(path, storyId)
      .then((result) => !cancelled && setDiff(result))
      .catch((reason: unknown) => !cancelled && setError(String(reason)));
    workflowApi
      .commits(path, storyId)
      .then((result) => !cancelled && setCommits(result))
      .catch(() => !cancelled && setCommits([]));
    return () => {
      cancelled = true;
    };
  }, [path, storyId, reload]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <span className="font-mono">{storyId}</span>
        {diff && (
          <span className="text-muted">
            {diff.files.length} file(s) changed against <span className="font-mono">{diff.base}</span>, including uncommitted edits
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className="rounded border border-line px-2 py-0.5 text-muted hover:text-fg" onClick={() => setReload(reload + 1)}>
          Refresh
        </button>
      </div>
      {error && <div className="px-4 py-2 text-bad">{error}</div>}
      <div className="flex-1 overflow-auto px-4 py-3">
        {check && (
          <details className="mb-3 rounded border border-line p-2" open={!check.passed}>
            <summary className={`cursor-pointer ${check.passed ? 'text-ok' : 'text-bad'}`}>Checks {check.passed ? 'passed' : 'failed'} (last run by CuciCode)</summary>
            {check.results.map((result) => (
              <div key={result.command} className="mt-2">
                <div className="font-mono text-[12px]">
                  <span className={result.passed ? 'text-ok' : 'text-bad'}>{result.passed ? 'ok' : `exit ${result.exitCode ?? '?'}`}</span> $ {result.command}{' '}
                  <span className="text-muted">{(result.durationMs / 1000).toFixed(1)}s</span>
                </div>
                {!result.passed && <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">{result.output}</pre>}
              </div>
            ))}
          </details>
        )}
        {commits.length > 0 && (
          <details className="mb-3 rounded border border-line p-2">
            <summary className="cursor-pointer">
              Checkpoints ({commits.length - 1}) <span className="text-muted">— CuciCode commits the worktree after every worker turn</span>
            </summary>
            {commits.map((commit, index) => (
              <div key={commit.sha} className="mt-1 flex flex-wrap items-baseline gap-2 font-mono text-[12px]">
                <span className="text-muted">{commit.short}</span>
                <span className="min-w-0 flex-1 truncate">{commit.isBase ? `start of the story (${commit.subject})` : commit.subject}</span>
                <span className="text-[11px] text-muted">{new Date(commit.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                {index === 0 ? (
                  <span className="text-[11px] text-ok">current</span>
                ) : confirming === commit.sha ? (
                  <>
                    <button type="button" className="text-[11px] text-bad" onClick={() => void rewindTo(commit.sha)}>
                      discard everything after this
                    </button>
                    <button type="button" className="text-[11px] text-muted" onClick={() => setConfirming(null)}>
                      cancel
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={working} className="text-[11px] text-muted hover:text-fg disabled:opacity-40" title={working ? 'Wait for the worker to finish its turn' : 'Reset the story branch to this commit'} onClick={() => setConfirming(commit.sha)}>
                    rewind to here
                  </button>
                )}
              </div>
            ))}
          </details>
        )}
        {diff && (
          <>
            <table className="mb-3 font-mono text-[12px]">
              <tbody>
                {diff.files.map((file) => (
                  <tr key={file.path}>
                    <td className="pr-3 text-right text-ok">{file.added === null ? 'bin' : `+${file.added}`}</td>
                    <td className="pr-3 text-right text-bad">{file.removed === null ? '' : `-${file.removed}`}</td>
                    <td>{file.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {diff.files.length === 0 && <div className="text-muted">No changes yet.</div>}
            {diff.truncated && <div className="mb-2 text-warn">The diff is long and was cut off; open the worktree to see all of it.</div>}
            <pre className="font-mono text-[12px] leading-[1.45]">
              {diff.patch.split('\n').map((line, index) => (
                <div key={index} className={lineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

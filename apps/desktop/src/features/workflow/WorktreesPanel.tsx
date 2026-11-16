import { useState } from 'react';
import { useWorkflow } from './workflowStore.ts';

export function WorktreesPanel({ projectId }: { projectId: string }) {
  const worktrees = useWorkflow((state) => state.projects[projectId]?.worktrees);
  const setView = useWorkflow((state) => state.setView);
  const discard = useWorkflow((state) => state.discardWorktree);
  const refresh = useWorkflow((state) => state.refresh);
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!worktrees || worktrees.length === 0) {
    return null;
  }
  return (
    <div className="border-b border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11px] tracking-wide text-muted uppercase">Worktrees ({worktrees.length})</span>
        <span className="flex-1" />
        <button type="button" className="text-[11px] text-muted hover:text-fg" onClick={() => void refresh(projectId)}>
          refresh
        </button>
      </div>
      {worktrees.map((worktree) => (
        <div key={worktree.storyId} className="py-1">
          <div className="flex items-baseline gap-2 font-mono text-[12px]">
            <span>{worktree.storyId}</span>
            <span className="text-[11px] text-muted" title={worktree.path}>
              {worktree.branch}
            </span>
            <span className="flex-1" />
            <span className={`text-[11px] ${worktree.dirty ? 'text-warn' : 'text-ok'}`}>{worktree.dirty ? 'uncommitted' : 'clean'}</span>
          </div>
          <div className="flex gap-3 text-[11px] text-muted">
            <span>
              {worktree.commitsAhead} commit(s) · {worktree.changedFiles} file(s)
            </span>
            <span className="flex-1" />
            <button type="button" className="hover:text-fg" onClick={() => setView(projectId, { kind: 'diff', storyId: worktree.storyId })}>
              diff
            </button>
            {confirming === worktree.storyId ? (
              <>
                <button type="button" className="text-bad" title="Deletes the folder and the story branch, including unmerged work" onClick={() => void discard(projectId, worktree.storyId).then(() => setConfirming(null))}>
                  discard for good
                </button>
                <button type="button" onClick={() => setConfirming(null)}>
                  cancel
                </button>
              </>
            ) : (
              <button type="button" className="hover:text-bad" onClick={() => setConfirming(worktree.storyId)}>
                discard
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

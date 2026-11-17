import { useState } from 'react';
import { buildableFeatures, FEATURE_STAGES, ONBOARD_INFO, ONBOARD_STAGES, type FeatureRun, type OnboardStage, type StoryRun, type StoryStage } from './pipeline.ts';
import { useWorkflow } from './workflowStore.ts';

const STAGE_TONE: Record<StoryStage, string> = {
  queued: 'text-muted',
  building: 'text-accent',
  checks: 'text-accent',
  fixing: 'text-warn',
  review: 'text-accent',
  awaiting_approval: 'text-warn',
  merging: 'text-accent',
  merged: 'text-ok',
  failed: 'text-bad',
};

const button = 'rounded border border-line px-2 py-0.5 hover:bg-raised disabled:opacity-40';
const primary = 'rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 disabled:opacity-40';

function StartForm({ projectId }: { projectId: string }) {
  const dispatch = useWorkflow((state) => state.dispatch);
  const allStories = useWorkflow((state) => state.projects[projectId]?.stories);
  const pending = buildableFeatures(allStories ?? []);
  const [feature, setFeature] = useState('');
  const [idea, setIdea] = useState('');
  const [skip, setSkip] = useState(false);
  const ready = feature.trim().length > 0 && idea.trim().length > 0;
  const input = 'w-full rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent';
  return (
    <div className="flex flex-col gap-1">
      <input className={input} placeholder="Feature name, e.g. user login" value={feature} onChange={(event) => setFeature(event.target.value)} />
      <textarea className={`${input} resize-none`} rows={3} placeholder="What should it do?" value={idea} onChange={(event) => setIdea(event.target.value)} />
      <label className="flex items-center gap-1 text-[11px] text-muted">
        <input type="checkbox" checked={skip} onChange={(event) => setSkip(event.target.checked)} />
        skip brainstorm, go straight to the plan
      </label>
      <button type="button" disabled={!ready} className={primary} onClick={() => void dispatch(projectId, { type: 'start', feature, idea, skipBrainstorm: skip })}>
        Start feature
      </button>
      {pending.length > 0 && (
        <div className="mt-2 border-t border-line/60 pt-2 text-[11px] text-muted">
          Stories already written and not built yet:
          {pending.map((group) => (
            <button
              key={group.feature}
              type="button"
              className={`${button} mt-1 block text-left text-fg`}
              title={group.stories.map((story) => story.id).join(', ')}
              onClick={() => void dispatch(projectId, { type: 'start_build', feature: group.feature, stories: group.stories })}
            >
              Build {group.stories.length} {group.stories.length === 1 ? 'story' : 'stories'} of {group.feature}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 border-t border-line/60 pt-2 text-[11px] text-muted">
        Existing codebase that was not started with CuciCode? Map it first, one reviewed stage at a time.
        <button type="button" className={`${button} mt-1 block text-fg`} onClick={() => void dispatch(projectId, { type: 'start_onboard' })}>
          Onboard this project
        </button>
      </div>
    </div>
  );
}

function RejectBox({ label, onReject }: { label: string; onReject: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className={button} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="mt-1 flex w-full flex-col gap-1">
      <textarea autoFocus rows={2} className="w-full resize-none rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent" placeholder="What should change?" value={reason} onChange={(event) => setReason(event.target.value)} />
      <div className="flex gap-2">
        <button type="button" disabled={reason.trim().length === 0} className={button} onClick={() => onReject(reason.trim())}>
          Send back
        </button>
        <button type="button" className="text-muted" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
    </div>
  );
}

function StoryRow({ projectId, story, title }: { projectId: string; story: StoryRun; title: string }) {
  const dispatch = useWorkflow((state) => state.dispatch);
  const setView = useWorkflow((state) => state.setView);
  const label = story.stage === 'awaiting_approval' ? (story.awaiting === 'checks' ? 'checks passed' : 'ready to merge') : story.stage.replace('_', ' ');
  return (
    <div className="border-t border-line/60 py-1.5">
      <div className="flex items-baseline gap-2">
        <button type="button" className="font-mono text-[12px] hover:text-accent" title="Open the worker's session" onClick={() => setView(projectId, { kind: 'worker', storyId: story.id })}>
          {story.id}
        </button>
        <span className="min-w-0 flex-1 truncate text-muted" title={title}>
          {title}
        </span>
        <span className={`font-mono text-[11px] ${STAGE_TONE[story.stage]}`}>
          {label}
          {story.fixRounds > 0 ? ` · fix ${story.fixRounds}` : ''}
        </span>
      </div>
      {story.stage === 'failed' && story.note && <div className="text-[11px] text-bad">{story.note}</div>}
      {(story.stage === 'awaiting_approval' || story.stage === 'failed') && (
        <div className="mt-1 flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => setView(projectId, { kind: 'diff', storyId: story.id })}>
            View diff
          </button>
          {story.stage === 'awaiting_approval' && (
            <>
              <button type="button" className={primary} onClick={() => void dispatch(projectId, { type: 'approve', storyId: story.id })}>
                {story.awaiting === 'checks' ? 'Start review' : 'Approve and merge'}
              </button>
              <RejectBox label="Request changes" onReject={(reason) => void dispatch(projectId, { type: 'reject', storyId: story.id, reason })} />
            </>
          )}
          {story.stage === 'failed' && (
            <button type="button" className={button} onClick={() => void dispatch(projectId, { type: 'retry', storyId: story.id })}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RunView({ projectId, run }: { projectId: string; run: FeatureRun }) {
  const dispatch = useWorkflow((state) => state.dispatch);
  const clearRun = useWorkflow((state) => state.clearRun);
  const stories = useWorkflow((state) => state.projects[projectId]?.stories);
  const [confirmClose, setConfirmClose] = useState(false);
  const titleOf = (id: string): string => stories?.find((story) => story.id === id)?.title ?? '';
  const stages: readonly string[] = run.kind === 'onboard' ? ONBOARD_STAGES : FEATURE_STAGES;
  const stageIndex = stages.indexOf(run.stage);
  const onboardStage = run.awaiting !== null && run.awaiting !== 'plan' && run.awaiting !== 'stories' ? (run.awaiting as OnboardStage) : null;
  const stalled = run.status === 'waiting' && run.awaiting === null && run.stage !== 'build';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono">{run.feature}</span>
        <span className={`font-mono text-[11px] ${run.status === 'working' ? 'text-accent' : run.status === 'waiting' ? 'text-warn' : 'text-muted'}`}>{run.status}</span>
      </div>
      <div className="flex gap-1 font-mono text-[11px]">
        {stages.map((stage, index) => (
          <span key={stage} className={`flex-1 border-t-2 pt-1 text-center ${index < stageIndex ? 'border-ok text-muted' : index === stageIndex ? 'border-accent text-fg' : 'border-line text-muted'}`}>
            {stage}
          </span>
        ))}
      </div>

      {run.stage === 'brainstorm' && run.status !== 'working' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Keep talking in the chat, then:</span>
          <button type="button" className={primary} onClick={() => void dispatch(projectId, { type: 'advance' })}>
            Write the plan
          </button>
        </div>
      )}
      {run.awaiting !== null && (
        <div className="rounded border border-warn/60 p-2">
          <div className="mb-1">
            {onboardStage ? (
              <>
                <span className="text-muted">{ONBOARD_INFO[onboardStage]}.</span> Read{' '}
                <span className="font-mono">{onboardStage === 'backlog' ? 'the new stories in the Stories folder' : `Plans/onboarding/${onboardStage}.md`}</span>, then decide.
              </>
            ) : run.awaiting === 'plan' ? (
              <>
                Read <span className="font-mono">Plans/{run.feature}.md</span>, then decide.
              </>
            ) : (
              <>Review the {Object.keys(run.stories).length} stories below (files are in the Stories folder), then decide.</>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => void dispatch(projectId, { type: 'approve' })}>
              {onboardStage ? (onboardStage === 'backlog' ? 'Approve and finish' : 'Approve and continue') : run.awaiting === 'plan' ? 'Approve plan' : 'Approve stories and build'}
            </button>
            <RejectBox label="Request changes" onReject={(reason) => void dispatch(projectId, { type: 'reject', reason })} />
          </div>
        </div>
      )}
      {stalled && run.stage !== 'brainstorm' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-warn">This stage stopped before finishing.</span>
          <button type="button" className={button} onClick={() => void dispatch(projectId, { type: 'retry_stage' })}>
            Run it again
          </button>
        </div>
      )}

      {Object.values(run.stories).length > 0 && (
        <div>
          {Object.values(run.stories).map((story) => (
            <StoryRow key={story.id} projectId={projectId} story={story} title={titleOf(story.id)} />
          ))}
        </div>
      )}

      <details>
        <summary className="cursor-pointer font-mono text-[11px] text-muted">log ({run.log.length})</summary>
        <div className="mt-1 max-h-40 overflow-y-auto font-mono text-[11px] text-muted">
          {run.log.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      </details>
      {confirmClose ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted">Plans, stories and worktrees stay on disk.</span>
          <button type="button" className="text-bad" onClick={() => void clearRun(projectId)}>
            Close this run
          </button>
          <button type="button" className="text-muted" onClick={() => setConfirmClose(false)}>
            cancel
          </button>
        </div>
      ) : (
        <button type="button" className="self-start text-[11px] text-muted hover:text-fg" onClick={() => setConfirmClose(true)}>
          {run.stage === 'done' ? (run.kind === 'onboard' ? 'Close; stories from the backlog can now be built as a feature' : 'Close and start another feature') : 'Abandon this run'}
        </button>
      )}
    </div>
  );
}

export function PipelinePanel({ projectId }: { projectId: string }) {
  const workflow = useWorkflow((state) => state.projects[projectId]);
  const dismissNotices = useWorkflow((state) => state.dismissNotices);
  return (
    <div className="border-b border-line p-3">
      <div className="mb-2 font-mono text-[11px] tracking-wide text-muted uppercase">Pipeline</div>
      {!workflow ? <div className="text-muted">Loading…</div> : workflow.run ? <RunView projectId={projectId} run={workflow.run} /> : <StartForm projectId={projectId} />}
      {workflow && workflow.notices.length > 0 && (
        <div className="mt-2 rounded border border-line p-2 text-[11px]">
          {workflow.notices.slice(-4).map((notice) => (
            <div key={`${notice.ts}-${notice.text}`} className="text-muted">
              {notice.text}
            </div>
          ))}
          <button type="button" className="mt-1 text-muted hover:text-fg" onClick={() => dismissNotices(projectId)}>
            clear
          </button>
        </div>
      )}
    </div>
  );
}

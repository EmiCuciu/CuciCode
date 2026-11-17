import { ROLE_INFO, type Role, type WorkflowConfig } from './config.ts';

export const FEATURE_STAGES = ['brainstorm', 'plan', 'stories', 'build', 'done'] as const;
export const ONBOARD_STAGES = ['map', 'baseline', 'scope', 'audit', 'backlog', 'done'] as const;
export type OnboardStage = Exclude<(typeof ONBOARD_STAGES)[number], 'done'>;
export type FeatureStage = (typeof FEATURE_STAGES)[number] | OnboardStage;

export const ONBOARD_INFO: Record<OnboardStage, string> = {
  map: 'Describe the project: purpose, stack, structure, how to run and test it',
  baseline: 'Run the tests and build, and record what passes and fails today',
  scope: 'Agree which parts agents may work on and which are off limits',
  audit: 'List problems worth fixing inside the agreed scope, with evidence',
  backlog: 'Turn the audit items you approve into stories',
};

export type StoryStage = 'queued' | 'building' | 'checks' | 'fixing' | 'review' | 'awaiting_approval' | 'merging' | 'merged' | 'failed';

export interface StoryRun {
  id: string;
  dependsOn: string[];
  stage: StoryStage;
  fixRounds: number;
  /** Which finished stage is waiting for the user, when `stage` is `awaiting_approval`. */
  awaiting: 'checks' | 'review' | null;
  /** What sent the story back to the worker last, so a fix can be followed by the right next step. */
  note: string | null;
}

export interface FeatureRun {
  /** `feature` builds something new; `onboard` brings an existing project into the workflow. */
  kind: 'feature' | 'onboard';
  feature: string;
  idea: string;
  stage: FeatureStage;
  /** `working`: an agent turn is in progress. `waiting`: the user decides what happens next. */
  status: 'working' | 'waiting' | 'idle';
  awaiting: 'plan' | 'stories' | OnboardStage | null;
  stories: Record<string, StoryRun>;
  log: string[];
}

export type Effect =
  | { type: 'send_main'; prompt: string }
  | { type: 'load_stories' }
  | { type: 'start_worker'; storyId: string; prompt: string }
  | { type: 'send_worker'; storyId: string; prompt: string }
  | { type: 'run_checks'; storyId: string }
  | { type: 'merge'; storyId: string }
  | { type: 'notify'; text: string };

export type PipelineEvent =
  | { type: 'start'; feature: string; idea: string; skipBrainstorm: boolean }
  | { type: 'start_onboard' }
  | { type: 'start_build'; feature: string; stories: { id: string; dependsOn: string[] }[] }
  | { type: 'advance' }
  | { type: 'main_turn_done' }
  | { type: 'main_turn_failed'; error: string }
  | { type: 'retry_stage' }
  | { type: 'stories_loaded'; stories: { id: string; dependsOn: string[] }[] }
  | { type: 'approve'; storyId?: string }
  | { type: 'reject'; storyId?: string; reason: string }
  | { type: 'worker_turn_done'; storyId: string; text: string }
  | { type: 'worker_failed'; storyId: string; error: string }
  | { type: 'checks_done'; storyId: string; passed: boolean; output: string }
  | { type: 'merged'; storyId: string }
  | { type: 'merge_failed'; storyId: string; error: string }
  | { type: 'retry'; storyId: string };

export interface StepResult {
  run: FeatureRun;
  effects: Effect[];
}

const ACTIVE: ReadonlySet<StoryStage> = new Set(['building', 'checks', 'fixing', 'review', 'merging']);

const WORKER_GIT_COMMANDS = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit'];

/**
 * Permission rules for a worker session: the project's check commands and the git commands a
 * worker needs. Everything else a worker wants to run in a shell still asks the user.
 */
export function workerAllowedTools(checkCommands: string[]): string[] {
  const commands = [...checkCommands.map((command) => command.trim()).filter((command) => command.length > 0), ...WORKER_GIT_COMMANDS];
  return ['Bash', 'PowerShell'].flatMap((tool) => commands.flatMap((command) => [`${tool}(${command})`, `${tool}(${command}:*)`]));
}

/**
 * A turn cut short by the subscription limit still ends with a "success" result whose only
 * text is Claude Code's limit message, so it must not be mistaken for finished work.
 */
export function isUsageLimitText(text: string): boolean {
  return /^\s*you(?:'|’)ve hit your\b[^\n]*\blimit\b/i.test(text);
}

export function featureSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Adds "use this agent instead" when a role is mapped to something other than CuciCode's own agent. */
function withAgent(prompt: string, config: WorkflowConfig, roles: Role[]): string {
  const swaps = roles
    .map((role) => ({ from: ROLE_INFO[role].defaultAgent, to: config.routing.roles[role].agent }))
    .filter((swap) => swap.to.length > 0 && swap.to !== swap.from);
  return swaps.length === 0 ? prompt : `${prompt}\n\n${swaps.map((swap) => `Use the \`${swap.to}\` agent instead of \`${swap.from}\`.`).join('\n')}`;
}

export const NO_VERDICT = 'the review ended without a RESULT line';

const REVIEWERS: Role[] = ['reviewerLogic', 'reviewerSecurity', 'reviewerCodeRules', 'reviewerUi'];

/** Reads the verdict line the review skill ends with. */
export function reviewResult(text: string): 'approved' | 'changes_requested' | null {
  const matches = [...text.matchAll(/RESULT:\s*(approved|changes_requested)/gi)];
  const last = matches[matches.length - 1]?.[1]?.toLowerCase();
  return last === 'approved' || last === 'changes_requested' ? last : null;
}

function log(run: FeatureRun, text: string): FeatureRun {
  return { ...run, log: [...run.log, text].slice(-200) };
}

function setStory(run: FeatureRun, id: string, patch: Partial<StoryRun>): FeatureRun {
  const story = run.stories[id];
  return story ? { ...run, stories: { ...run.stories, [id]: { ...story, ...patch } } } : run;
}

function needsMergeApproval(config: WorkflowConfig): boolean {
  return config.pipeline.approvals.review || config.git.mergeMode === 'approval';
}

/** Starts queued stories whose dependencies are merged, up to the parallel limit, and settles the feature status. */
function schedule(run: FeatureRun, config: WorkflowConfig): StepResult {
  const effects: Effect[] = [];
  let next = run;
  if (next.stage === 'build') {
    let active = Object.values(next.stories).filter((story) => ACTIVE.has(story.stage)).length;
    for (const story of Object.values(next.stories)) {
      if (active >= config.git.maxParallelWorktrees) {
        break;
      }
      const ready = story.stage === 'queued' && story.dependsOn.every((dependency) => !next.stories[dependency] || next.stories[dependency].stage === 'merged');
      if (ready) {
        next = setStory(next, story.id, { stage: 'building' });
        effects.push({ type: 'start_worker', storyId: story.id, prompt: `/cucicode:build ${story.id}` });
        active += 1;
      }
    }
    const all = Object.values(next.stories);
    if (all.length > 0 && all.every((story) => story.stage === 'merged')) {
      next = log({ ...next, stage: 'done', status: 'idle' }, 'All stories are merged.');
      effects.push({ type: 'notify', text: `${next.feature}: all stories are merged` });
    } else {
      const working = all.some((story) => ACTIVE.has(story.stage));
      const waiting = all.some((story) => story.stage === 'awaiting_approval' || story.stage === 'failed');
      next = { ...next, status: working ? 'working' : waiting ? 'waiting' : 'idle' };
    }
  }
  return { run: next, effects };
}

function enterStage(run: FeatureRun, stage: FeatureStage, config: WorkflowConfig): StepResult {
  const base: FeatureRun = { ...run, stage, awaiting: null, status: 'working' };
  switch (stage) {
    case 'brainstorm':
      return { run: log(base, 'Brainstorm started.'), effects: [{ type: 'send_main', prompt: withAgent(`/cucicode:brainstorm ${run.idea}`, config, ['planner']) }] };
    case 'plan':
      return { run: log(base, 'Planning started.'), effects: [{ type: 'send_main', prompt: withAgent(`/cucicode:plan ${run.feature}: ${run.idea}`, config, ['planner']) }] };
    case 'stories':
      return { run: log(base, 'Writing stories.'), effects: [{ type: 'send_main', prompt: withAgent(`/cucicode:stories ${run.feature}`, config, ['storyWriter']) }] };
    case 'build': {
      const queued = Object.fromEntries(Object.values(run.stories).map((story) => [story.id, { ...story, stage: story.stage === 'merged' ? story.stage : ('queued' as StoryStage) }]));
      return schedule(log({ ...base, stories: queued }, 'Build started.'), config);
    }
    case 'done':
      return { run: { ...base, status: 'idle' }, effects: [] };
    default:
      return {
        run: log(base, `Onboarding: ${stage} started.`),
        effects: [{ type: 'send_main', prompt: withAgent(`/cucicode:onboard ${stage}`, config, stage === 'backlog' ? ['storyWriter'] : ['explorer']) }],
      };
  }
}

function isOnboardStage(stage: FeatureStage): stage is OnboardStage {
  return stage !== 'done' && (ONBOARD_STAGES as readonly string[]).includes(stage);
}

function nextOnboardStage(stage: OnboardStage): (typeof ONBOARD_STAGES)[number] {
  return ONBOARD_STAGES[ONBOARD_STAGES.indexOf(stage) + 1] ?? 'done';
}

function sendBack(run: FeatureRun, storyId: string, config: WorkflowConfig, reason: string, what: string): StepResult {
  const story = run.stories[storyId];
  if (!story) {
    return { run, effects: [] };
  }
  if (story.fixRounds >= config.pipeline.maxFixRounds) {
    const failed = log(setStory(run, storyId, { stage: 'failed', note: `${what} after ${story.fixRounds} fix round(s)` }), `${storyId}: ${what}; the fix limit is reached.`);
    const scheduled = schedule(failed, config);
    return { run: scheduled.run, effects: [...scheduled.effects, { type: 'notify', text: `${storyId} needs you: ${what}` }] };
  }
  const fixing = log(setStory(run, storyId, { stage: 'fixing', fixRounds: story.fixRounds + 1, awaiting: null, note: what }), `${storyId}: ${what}; sent back to the worker (round ${story.fixRounds + 1}).`);
  return { run: { ...fixing, status: 'working' }, effects: [{ type: 'send_worker', storyId, prompt: `/cucicode:fix ${storyId}\n\n${reason}` }] };
}

function afterReviewApproved(run: FeatureRun, storyId: string, config: WorkflowConfig): StepResult {
  if (needsMergeApproval(config)) {
    const waiting = log(setStory(run, storyId, { stage: 'awaiting_approval', awaiting: 'review' }), `${storyId}: review approved; waiting for your approval to merge.`);
    const scheduled = schedule(waiting, config);
    return { run: scheduled.run, effects: [...scheduled.effects, { type: 'notify', text: `${storyId} is ready to merge` }] };
  }
  return { run: log(setStory(run, storyId, { stage: 'merging', awaiting: null }), `${storyId}: review approved; merging.`), effects: [{ type: 'merge', storyId }] };
}

function startReview(run: FeatureRun, storyId: string, config: WorkflowConfig): StepResult {
  return {
    run: log(setStory(run, storyId, { stage: 'review', awaiting: null }), `${storyId}: review started.`),
    effects: [{ type: 'send_worker', storyId, prompt: withAgent(`/cucicode:review ${storyId}`, config, REVIEWERS) }],
  };
}

export function newRun(): FeatureRun {
  return { kind: 'feature', feature: '', idea: '', stage: 'brainstorm', status: 'idle', awaiting: null, stories: {}, log: [] };
}

/** The whole pipeline as one pure function: the current run and an event in, the next run and the work to do out. */
export function step(run: FeatureRun, event: PipelineEvent, config: WorkflowConfig): StepResult {
  const none: StepResult = { run, effects: [] };
  switch (event.type) {
    case 'start': {
      const fresh: FeatureRun = { ...newRun(), feature: featureSlug(event.feature), idea: event.idea.trim() };
      return enterStage(fresh, event.skipBrainstorm ? 'plan' : 'brainstorm', config);
    }
    case 'start_build': {
      if (event.stories.length === 0) {
        return none;
      }
      const stories = Object.fromEntries(event.stories.map((story) => [story.id, { id: story.id, dependsOn: story.dependsOn, stage: 'queued' as StoryStage, fixRounds: 0, awaiting: null, note: null }]));
      return enterStage(log({ ...newRun(), feature: event.feature, idea: 'Build the existing stories', stories }, `Building ${event.stories.length} existing stories.`), 'build', config);
    }
    case 'start_onboard':
      return enterStage({ ...newRun(), kind: 'onboard', feature: 'onboarding', idea: 'Bring this existing project into the workflow' }, 'map', config);
    case 'advance':
      return run.stage === 'brainstorm' && run.status !== 'working' ? enterStage(run, 'plan', config) : none;
    case 'main_turn_done': {
      if (run.status !== 'working') {
        return none;
      }
      if (run.stage === 'brainstorm') {
        return { run: { ...run, status: 'waiting' }, effects: [] };
      }
      if (isOnboardStage(run.stage)) {
        return {
          run: log({ ...run, status: 'waiting', awaiting: run.stage }, `Onboarding: ${run.stage} is ready for your review.`),
          effects: [{ type: 'notify', text: `Onboarding: the ${run.stage} stage is ready for review` }],
        };
      }
      if (run.stage === 'plan') {
        if (config.pipeline.approvals.plan) {
          return { run: log({ ...run, status: 'waiting', awaiting: 'plan' }, 'Plan written; waiting for your approval.'), effects: [{ type: 'notify', text: `${run.feature}: the plan is ready for review` }] };
        }
        return enterStage(run, 'stories', config);
      }
      if (run.stage === 'stories') {
        return { run, effects: [{ type: 'load_stories' }] };
      }
      return none;
    }
    case 'main_turn_failed':
      return run.status === 'working' && run.stage !== 'build' && run.stage !== 'done'
        ? { run: log({ ...run, status: 'waiting', awaiting: null }, `The ${run.stage} turn stopped: ${event.error}`), effects: [] }
        : none;
    case 'retry_stage':
      return run.status === 'waiting' && run.awaiting === null && (run.stage === 'plan' || run.stage === 'stories' || run.stage === 'brainstorm' || isOnboardStage(run.stage)) ? enterStage(run, run.stage, config) : none;
    case 'stories_loaded': {
      if (run.stage !== 'stories') {
        return none;
      }
      if (event.stories.length === 0) {
        return { run: log({ ...run, status: 'waiting', awaiting: null }, 'No stories were found for this feature.'), effects: [{ type: 'notify', text: `${run.feature}: no stories were written` }] };
      }
      const stories = Object.fromEntries(event.stories.map((story) => [story.id, { id: story.id, dependsOn: story.dependsOn, stage: 'queued' as StoryStage, fixRounds: 0, awaiting: null, note: null }]));
      const loaded: FeatureRun = { ...run, stories };
      if (config.pipeline.approvals.stories) {
        return { run: log({ ...loaded, status: 'waiting', awaiting: 'stories' }, `${event.stories.length} stories written; waiting for your approval.`), effects: [{ type: 'notify', text: `${run.feature}: ${event.stories.length} stories are ready for review` }] };
      }
      return enterStage(loaded, 'build', config);
    }
    case 'approve': {
      if (event.storyId === undefined) {
        if (run.awaiting === 'plan') {
          return enterStage(log(run, 'Plan approved.'), 'stories', config);
        }
        if (run.awaiting === 'stories') {
          return enterStage(log(run, 'Stories approved.'), 'build', config);
        }
        if (run.awaiting !== null && isOnboardStage(run.awaiting)) {
          const next = nextOnboardStage(run.awaiting);
          const approved = log(run, `Onboarding: ${run.awaiting} approved.`);
          if (next === 'done') {
            return { run: log({ ...approved, stage: 'done', status: 'idle', awaiting: null }, 'Onboarding is complete.'), effects: [{ type: 'notify', text: 'Onboarding is complete' }] };
          }
          return enterStage(approved, next, config);
        }
        return none;
      }
      const story = run.stories[event.storyId];
      if (story?.stage !== 'awaiting_approval') {
        return none;
      }
      if (story.awaiting === 'checks') {
        return startReview({ ...run, status: 'working' }, story.id, config);
      }
      return { run: { ...log(setStory(run, story.id, { stage: 'merging', awaiting: null }), `${story.id}: merge approved.`), status: 'working' }, effects: [{ type: 'merge', storyId: story.id }] };
    }
    case 'reject': {
      if (event.storyId === undefined) {
        if (run.awaiting === 'plan') {
          return { run: log({ ...run, awaiting: null, status: 'working' }, 'Plan sent back for changes.'), effects: [{ type: 'send_main', prompt: `Revise the plan in Plans/${run.feature}.md. Keep everything that is not affected. What to change:\n\n${event.reason}` }] };
        }
        if (run.awaiting !== null && isOnboardStage(run.awaiting)) {
          const file = run.awaiting === 'backlog' ? 'the stories you wrote from the audit' : `Plans/onboarding/${run.awaiting}.md`;
          return { run: log({ ...run, awaiting: null, status: 'working' }, `Onboarding: ${run.awaiting} sent back for changes.`), effects: [{ type: 'send_main', prompt: `Revise ${file}. What to change:\n\n${event.reason}` }] };
        }
        if (run.awaiting === 'stories') {
          return { run: log({ ...run, awaiting: null, status: 'working' }, 'Stories sent back for changes.'), effects: [{ type: 'send_main', prompt: `Revise the stories for the feature "${run.feature}" in the Stories folder. What to change:\n\n${event.reason}` }] };
        }
        return none;
      }
      if (run.stories[event.storyId]?.stage !== 'awaiting_approval') {
        return none;
      }
      const reset = setStory(run, event.storyId, { fixRounds: Math.min(run.stories[event.storyId]?.fixRounds ?? 0, Math.max(0, config.pipeline.maxFixRounds - 1)) });
      return sendBack(reset, event.storyId, config, `The user asked for these changes:\n\n${event.reason}`, 'you requested changes');
    }
    case 'worker_turn_done': {
      const story = run.stories[event.storyId];
      if (!story) {
        return none;
      }
      if (story.stage === 'failed' && story.note === NO_VERDICT) {
        const late = reviewResult(event.text);
        if (late === 'approved') {
          return afterReviewApproved({ ...log(run, `${story.id}: the review verdict arrived late.`), status: 'working' }, story.id, config);
        }
        if (late === 'changes_requested') {
          return sendBack(log(run, `${story.id}: the review verdict arrived late.`), story.id, config, `The review requested changes. Fix the blocking findings below.\n\n${event.text}`, 'review requested changes');
        }
        return none;
      }
      if (story.stage === 'building' || story.stage === 'fixing') {
        return { run: log(setStory(run, story.id, { stage: 'checks' }), `${story.id}: running checks.`), effects: [{ type: 'run_checks', storyId: story.id }] };
      }
      if (story.stage === 'review') {
        const result = reviewResult(event.text);
        if (result === 'approved') {
          return afterReviewApproved(run, story.id, config);
        }
        if (result === 'changes_requested') {
          return sendBack(run, story.id, config, `The review requested changes. Fix the blocking findings below.\n\n${event.text}`, 'review requested changes');
        }
        const failed = log(setStory(run, story.id, { stage: 'failed', note: NO_VERDICT }), `${story.id}: the review gave no verdict.`);
        const scheduled = schedule(failed, config);
        return { run: scheduled.run, effects: [...scheduled.effects, { type: 'notify', text: `${story.id} needs you: the review gave no verdict` }] };
      }
      return none;
    }
    case 'checks_done': {
      const story = run.stories[event.storyId];
      if (story?.stage !== 'checks') {
        return none;
      }
      if (!event.passed) {
        return sendBack(run, story.id, config, `These checks failed. Fix the cause, not the test.\n\n${event.output}`, 'checks failed');
      }
      if (config.pipeline.approvals.checks) {
        const waiting = log(setStory(run, story.id, { stage: 'awaiting_approval', awaiting: 'checks' }), `${story.id}: checks passed; waiting for your approval to review.`);
        const scheduled = schedule(waiting, config);
        return { run: scheduled.run, effects: [...scheduled.effects, { type: 'notify', text: `${story.id}: checks passed, ready for review` }] };
      }
      return startReview(log(run, `${story.id}: checks passed.`), story.id, config);
    }
    case 'merged': {
      if (!run.stories[event.storyId]) {
        return none;
      }
      return schedule(log(setStory(run, event.storyId, { stage: 'merged', awaiting: null, note: null }), `${event.storyId}: merged.`), config);
    }
    case 'merge_failed':
    case 'worker_failed': {
      if (!run.stories[event.storyId]) {
        return none;
      }
      const failed = log(setStory(run, event.storyId, { stage: 'failed', awaiting: null, note: event.error }), `${event.storyId}: ${event.error}`);
      const scheduled = schedule(failed, config);
      return { run: scheduled.run, effects: [...scheduled.effects, { type: 'notify', text: `${event.storyId} needs you: ${event.error}` }] };
    }
    case 'retry': {
      const failed = run.stories[event.storyId];
      if (failed?.stage !== 'failed') {
        return none;
      }
      if (failed.note === NO_VERDICT) {
        return startReview({ ...log(setStory(run, failed.id, { note: null }), `${failed.id}: review started again.`), status: 'working' }, failed.id, config);
      }
      return schedule(log(setStory(run, event.storyId, { stage: 'queued', fixRounds: 0, note: null }), `${event.storyId}: queued again.`), config);
    }
  }
}

/** Stories on disk that are not archived or done, grouped by feature, for starting a build without re-planning. */
export function buildableFeatures(stories: { id: string; feature: string; status: string; archived: boolean; dependsOn: string[] }[]): { feature: string; stories: { id: string; dependsOn: string[] }[] }[] {
  const groups = new Map<string, { id: string; dependsOn: string[] }[]>();
  for (const story of stories) {
    if (story.archived || story.status === 'done' || story.feature.length === 0) {
      continue;
    }
    groups.set(story.feature, [...(groups.get(story.feature) ?? []), { id: story.id, dependsOn: story.dependsOn }]);
  }
  return [...groups.entries()].map(([feature, list]) => ({ feature, stories: list.sort((left, right) => left.id.localeCompare(right.id)) }));
}

/** What is waiting for the user in a run, for the Inbox. */
export function pendingItems(run: FeatureRun | null): { storyId: string | null; text: string }[] {
  if (!run) {
    return [];
  }
  const items: { storyId: string | null; text: string }[] = [];
  if (run.awaiting === 'plan') {
    items.push({ storyId: null, text: `Plan for "${run.feature}" is ready for review` });
  }
  if (run.awaiting === 'stories') {
    items.push({ storyId: null, text: `Stories for "${run.feature}" are ready for review` });
  }
  if (run.awaiting !== null && isOnboardStage(run.awaiting)) {
    items.push({ storyId: null, text: `Onboarding: the ${run.awaiting} stage is ready for review` });
  }
  for (const story of Object.values(run.stories)) {
    if (story.stage === 'awaiting_approval') {
      items.push({ storyId: story.id, text: story.awaiting === 'checks' ? `${story.id}: checks passed, approve to review` : `${story.id}: reviewed, approve to merge` });
    } else if (story.stage === 'failed') {
      items.push({ storyId: story.id, text: `${story.id} failed: ${story.note ?? 'unknown reason'}` });
    }
  }
  return items;
}

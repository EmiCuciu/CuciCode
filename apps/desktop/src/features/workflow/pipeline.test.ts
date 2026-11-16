import { describe, expect, it } from 'vitest';
import { defaultConfig, resolveConfig, sessionRoute, sourceOf, type WorkflowConfig } from './config.ts';
import { featureSlug, newRun, pendingItems, reviewResult, step, type Effect, type FeatureRun, type PipelineEvent } from './pipeline.ts';

function config(patch: (config: WorkflowConfig) => void = () => {}): WorkflowConfig {
  const value = defaultConfig();
  patch(value);
  return value;
}

/** Feeds events through the engine and collects every effect, like the driver does. */
function play(events: PipelineEvent[], cfg: WorkflowConfig, start: FeatureRun = newRun()): { run: FeatureRun; effects: Effect[] } {
  let run = start;
  const effects: Effect[] = [];
  for (const event of events) {
    const result = step(run, event, cfg);
    run = result.run;
    effects.push(...result.effects);
  }
  return { run, effects };
}

const START: PipelineEvent = { type: 'start', feature: 'User Auth!', idea: 'let users log in', skipBrainstorm: true };
const TWO_STORIES: PipelineEvent = { type: 'stories_loaded', stories: [{ id: 'S-001', dependsOn: [] }, { id: 'S-002', dependsOn: ['S-001'] }] };
const toBuild = (cfg: WorkflowConfig): FeatureRun =>
  play([START, { type: 'main_turn_done' }, { type: 'approve' }, { type: 'main_turn_done' }, TWO_STORIES, { type: 'approve' }], cfg).run;
const types = (effects: Effect[]): string[] => effects.map((effect) => effect.type);

describe('feature stages', () => {
  it('starts with brainstorm, waits for the user, then plans', () => {
    const cfg = config();
    const started = step(newRun(), { ...START, skipBrainstorm: false }, cfg);
    expect(started.run).toMatchObject({ feature: 'user-auth', stage: 'brainstorm', status: 'working' });
    expect(started.effects).toEqual([{ type: 'send_main', prompt: '/cucicode:brainstorm let users log in' }]);
    const talked = step(started.run, { type: 'main_turn_done' }, cfg);
    expect(talked.run.status).toBe('waiting');
    expect(talked.effects).toEqual([]);
    const planning = step(talked.run, { type: 'advance' }, cfg);
    expect(planning.run.stage).toBe('plan');
    expect(planning.effects[0]).toEqual({ type: 'send_main', prompt: '/cucicode:plan user-auth: let users log in' });
  });

  it('stops for approval after the plan and after the stories when configured', () => {
    const cfg = config();
    const planned = play([START, { type: 'main_turn_done' }], cfg);
    expect(planned.run).toMatchObject({ stage: 'plan', status: 'waiting', awaiting: 'plan' });
    expect(types(planned.effects)).toEqual(['send_main', 'notify']);
    const stories = play([{ type: 'approve' }, { type: 'main_turn_done' }], cfg, planned.run);
    expect(stories.run.stage).toBe('stories');
    expect(types(stories.effects)).toEqual(['send_main', 'load_stories']);
    const loaded = step(stories.run, TWO_STORIES, cfg);
    expect(loaded.run).toMatchObject({ awaiting: 'stories', status: 'waiting' });
    expect(Object.keys(loaded.run.stories)).toEqual(['S-001', 'S-002']);
  });

  it('runs straight through when no approval is required', () => {
    const cfg = config((value) => {
      value.pipeline.approvals = { plan: false, stories: false, checks: false, review: false };
      value.git.mergeMode = 'auto';
    });
    const result = play([START, { type: 'main_turn_done' }, { type: 'main_turn_done' }, TWO_STORIES], cfg);
    expect(result.run.stage).toBe('build');
    expect(types(result.effects)).toEqual(['send_main', 'send_main', 'load_stories', 'start_worker']);
  });

  it('sends a rejected plan back with the reason and stays in the plan stage', () => {
    const cfg = config();
    const planned = play([START, { type: 'main_turn_done' }], cfg).run;
    const rejected = step(planned, { type: 'reject', reason: 'split the migration out' }, cfg);
    expect(rejected.run).toMatchObject({ stage: 'plan', status: 'working', awaiting: null });
    expect(rejected.effects[0]).toMatchObject({ type: 'send_main' });
    expect((rejected.effects[0] as { prompt: string }).prompt).toContain('split the migration out');
    expect(step(rejected.run, { type: 'main_turn_done' }, cfg).run.awaiting).toBe('plan');
  });

  it('reports when the story stage produced no stories', () => {
    const cfg = config();
    const run = play([START, { type: 'main_turn_done' }, { type: 'approve' }, { type: 'main_turn_done' }, { type: 'stories_loaded', stories: [] }], cfg).run;
    expect(run).toMatchObject({ stage: 'stories', status: 'waiting' });
  });
});

describe('story flow', () => {
  it('starts only stories whose dependencies are merged, within the parallel limit', () => {
    const cfg = config();
    const run = toBuild(cfg);
    expect(run.stories['S-001']?.stage).toBe('building');
    expect(run.stories['S-002']?.stage).toBe('queued');

    const three: PipelineEvent = { type: 'stories_loaded', stories: ['A', 'B', 'C'].map((id) => ({ id, dependsOn: [] })) };
    const parallel = play([START, { type: 'main_turn_done' }, { type: 'approve' }, { type: 'main_turn_done' }, three, { type: 'approve' }], cfg);
    expect(Object.values(parallel.run.stories).map((story) => story.stage)).toEqual(['building', 'building', 'queued']);
    expect(parallel.effects.filter((effect) => effect.type === 'start_worker')).toHaveLength(2);
  });

  it('goes build → checks → review → approval → merge, then starts the dependent story', () => {
    const cfg = config();
    const built = step(toBuild(cfg), { type: 'worker_turn_done', storyId: 'S-001', text: 'done' }, cfg);
    expect(built.effects).toEqual([{ type: 'run_checks', storyId: 'S-001' }]);
    const checked = step(built.run, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }, cfg);
    expect(checked.effects).toEqual([{ type: 'send_worker', storyId: 'S-001', prompt: '/cucicode:review S-001' }]);
    const reviewed = step(checked.run, { type: 'worker_turn_done', storyId: 'S-001', text: 'All good.\nRESULT: approved' }, cfg);
    expect(reviewed.run.stories['S-001']).toMatchObject({ stage: 'awaiting_approval', awaiting: 'review' });
    expect(reviewed.run.status).toBe('waiting');
    expect(pendingItems(reviewed.run)).toEqual([{ storyId: 'S-001', text: 'S-001: reviewed, approve to merge' }]);
    const approved = step(reviewed.run, { type: 'approve', storyId: 'S-001' }, cfg);
    expect(approved.effects).toEqual([{ type: 'merge', storyId: 'S-001' }]);
    const merged = step(approved.run, { type: 'merged', storyId: 'S-001' }, cfg);
    expect(merged.run.stories['S-001']?.stage).toBe('merged');
    expect(merged.run.stories['S-002']?.stage).toBe('building');
    expect(merged.effects).toEqual([{ type: 'start_worker', storyId: 'S-002', prompt: '/cucicode:build S-002' }]);
  });

  it('merges without asking when merge mode is automatic and review approval is off', () => {
    const cfg = config((value) => {
      value.pipeline.approvals.review = false;
      value.git.mergeMode = 'auto';
    });
    const run = play([{ type: 'worker_turn_done', storyId: 'S-001', text: '' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }], cfg, toBuild(cfg)).run;
    const reviewed = step(run, { type: 'worker_turn_done', storyId: 'S-001', text: 'RESULT: approved' }, cfg);
    expect(reviewed.effects).toEqual([{ type: 'merge', storyId: 'S-001' }]);
  });

  it('sends failing checks back to the worker until the fix limit, then stops and asks for help', () => {
    const cfg = config((value) => {
      value.pipeline.maxFixRounds = 2;
    });
    const fail: PipelineEvent = { type: 'checks_done', storyId: 'S-001', passed: false, output: 'test_login FAILED' };
    const turn: PipelineEvent = { type: 'worker_turn_done', storyId: 'S-001', text: '' };
    const first = play([turn, fail], cfg, toBuild(cfg));
    expect(first.run.stories['S-001']).toMatchObject({ stage: 'fixing', fixRounds: 1 });
    const fixPrompt = first.effects[first.effects.length - 1] as { type: string; prompt: string };
    expect(fixPrompt.type).toBe('send_worker');
    expect(fixPrompt.prompt).toContain('/cucicode:fix S-001');
    expect(fixPrompt.prompt).toContain('test_login FAILED');
    const second = play([turn, fail], cfg, first.run);
    expect(second.run.stories['S-001']?.fixRounds).toBe(2);
    const third = play([turn, fail], cfg, second.run);
    expect(third.run.stories['S-001']).toMatchObject({ stage: 'failed', fixRounds: 2 });
    expect(types(third.effects)).toEqual(['run_checks', 'notify']);
    expect(third.run.status).toBe('waiting');
    expect(types(third.effects)).not.toContain('send_worker');
  });

  it('never starts a review before checks pass', () => {
    const cfg = config();
    const effects = play([{ type: 'worker_turn_done', storyId: 'S-001', text: '' }, { type: 'checks_done', storyId: 'S-001', passed: false, output: 'x' }], cfg, toBuild(cfg)).effects;
    expect(effects.some((effect) => effect.type === 'send_worker' && effect.prompt.includes('/cucicode:review'))).toBe(false);
  });

  it('sends blocking review findings back, then re-checks and re-reviews', () => {
    const cfg = config();
    const inReview = play([{ type: 'worker_turn_done', storyId: 'S-001', text: '' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }], cfg, toBuild(cfg)).run;
    const changes = step(inReview, { type: 'worker_turn_done', storyId: 'S-001', text: 'blocking: null check missing\nRESULT: changes_requested' }, cfg);
    expect(changes.run.stories['S-001']).toMatchObject({ stage: 'fixing', fixRounds: 1 });
    expect((changes.effects[0] as { prompt: string }).prompt).toContain('null check missing');
    const again = play([{ type: 'worker_turn_done', storyId: 'S-001', text: 'fixed' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }], cfg, changes.run);
    expect(again.run.stories['S-001']?.stage).toBe('review');
  });

  it('fails a story whose review has no verdict, a failed merge, or a crashed worker, and lets it be retried', () => {
    const cfg = config();
    const inReview = play([{ type: 'worker_turn_done', storyId: 'S-001', text: '' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }], cfg, toBuild(cfg)).run;
    const noVerdict = step(inReview, { type: 'worker_turn_done', storyId: 'S-001', text: 'looks fine I guess' }, cfg);
    expect(noVerdict.run.stories['S-001']?.stage).toBe('failed');
    const mergeFailed = step(toBuild(cfg), { type: 'merge_failed', storyId: 'S-001', error: 'conflict in a.ts' }, cfg);
    expect(mergeFailed.run.stories['S-001']).toMatchObject({ stage: 'failed', note: 'conflict in a.ts' });
    expect(pendingItems(mergeFailed.run)[0]?.text).toContain('conflict in a.ts');
    const retried = step(mergeFailed.run, { type: 'retry', storyId: 'S-001' }, cfg);
    expect(retried.run.stories['S-001']).toMatchObject({ stage: 'building', fixRounds: 0 });
    expect(types(retried.effects)).toEqual(['start_worker']);
  });

  it('can pause after checks, and a rejected merge goes back to the worker with the reason', () => {
    const cfg = config((value) => {
      value.pipeline.approvals.checks = true;
    });
    const checked = play([{ type: 'worker_turn_done', storyId: 'S-001', text: '' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }], cfg, toBuild(cfg));
    expect(checked.run.stories['S-001']).toMatchObject({ stage: 'awaiting_approval', awaiting: 'checks' });
    const review = step(checked.run, { type: 'approve', storyId: 'S-001' }, cfg);
    expect(review.run.stories['S-001']?.stage).toBe('review');
    const waiting = step(review.run, { type: 'worker_turn_done', storyId: 'S-001', text: 'RESULT: approved' }, cfg).run;
    const rejected = step(waiting, { type: 'reject', storyId: 'S-001', reason: 'rename the button' }, cfg);
    expect(rejected.run.stories['S-001']?.stage).toBe('fixing');
    expect((rejected.effects[0] as { prompt: string }).prompt).toContain('rename the button');
  });

  it('finishes the feature when every story is merged', () => {
    const cfg = config();
    const one: PipelineEvent = { type: 'stories_loaded', stories: [{ id: 'S-001', dependsOn: [] }] };
    const building = play([START, { type: 'main_turn_done' }, { type: 'approve' }, { type: 'main_turn_done' }, one, { type: 'approve' }], cfg).run;
    const done = step(building, { type: 'merged', storyId: 'S-001' }, cfg);
    expect(done.run).toMatchObject({ stage: 'done', status: 'idle' });
    expect(types(done.effects)).toEqual(['notify']);
  });

  it('ignores events that do not fit the current state', () => {
    const cfg = config();
    const run = toBuild(cfg);
    for (const event of [{ type: 'approve' }, { type: 'advance' }, { type: 'checks_done', storyId: 'S-001', passed: true, output: '' }, { type: 'merged', storyId: 'nope' }, { type: 'retry', storyId: 'S-001' }] as PipelineEvent[]) {
      expect(step(run, event, cfg)).toEqual({ run, effects: [] });
    }
  });
});

describe('helpers', () => {
  it('reads the last verdict line and makes safe feature names', () => {
    expect(reviewResult('RESULT: changes_requested\n...later...\nRESULT: approved')).toBe('approved');
    expect(reviewResult('result: Changes_Requested')).toBe('changes_requested');
    expect(reviewResult('no verdict')).toBeNull();
    expect(featureSlug('  User Auth / v2! ')).toBe('user-auth-v2');
  });

  it('names a replacement agent in the prompt when a role is mapped to another agent', () => {
    const cfg = config((value) => {
      value.routing.roles.planner.agent = 'my-planner';
    });
    const prompt = (step(newRun(), START, cfg).effects[0] as { prompt: string }).prompt;
    expect(prompt).toContain('Use the `my-planner` agent instead of `cucicode:planner`.');
    expect((step(newRun(), START, config()).effects[0] as { prompt: string }).prompt).not.toContain('instead of');
  });
});

describe('config', () => {
  it('layers defaults, project and personal settings and ignores bad values', () => {
    const resolved = resolveConfig(
      { pipeline: { maxFixRounds: 5, approvals: { plan: false, review: 'yes' } }, git: { maxParallelWorktrees: 99, protectedPaths: ['a', 7, ''] }, routing: { mode: 'predefined', roles: { worker: { model: 'opus' } } } },
      { git: { pushMode: 'pr', mergeMode: 'whatever' }, checks: { commands: ['npm test'] } },
    );
    expect(resolved.pipeline.maxFixRounds).toBe(5);
    expect(resolved.pipeline.approvals).toEqual({ plan: false, stories: true, checks: false, review: true });
    expect(resolved.git).toMatchObject({ maxParallelWorktrees: 8, protectedPaths: ['a'], pushMode: 'pr', mergeMode: 'approval' });
    expect(resolved.routing.roles.worker).toEqual({ agent: 'cucicode:worker', model: 'opus', effort: '' });
    expect(resolved.checks.commands).toEqual(['npm test']);
    expect(resolveConfig(null, 'nonsense')).toEqual(defaultConfig());
  });

  it('reports where a value comes from and routes sessions only in predefined mode', () => {
    expect(sourceOf({ git: { pushMode: 'pr' } }, { git: { pushMode: 'local' } }, 'git', 'pushMode')).toBe('local');
    expect(sourceOf({ git: { pushMode: 'pr' } }, {}, 'git', 'pushMode')).toBe('project');
    expect(sourceOf({}, {}, 'git', 'pushMode')).toBe('default');
    expect(sessionRoute(defaultConfig(), 'planner')).toEqual({ model: undefined, effort: undefined });
    const predefined = config((value) => {
      value.routing.mode = 'predefined';
    });
    expect(sessionRoute(predefined, 'planner')).toEqual({ model: 'opus', effort: 'high' });
    expect(sessionRoute(predefined, 'worker')).toEqual({ model: 'sonnet', effort: undefined });
  });
});

describe('stalled stages and modes', () => {
  it('a main turn that stops early leaves the stage waiting, and it can be run again', () => {
    const cfg = config();
    const planning = step(newRun(), START, cfg).run;
    const stopped = step(planning, { type: 'main_turn_failed', error: 'interrupted' }, cfg);
    expect(stopped.run).toMatchObject({ stage: 'plan', status: 'waiting', awaiting: null });
    expect(stopped.effects).toEqual([]);
    const again = step(stopped.run, { type: 'retry_stage' }, cfg);
    expect(again.run.status).toBe('working');
    expect(types(again.effects)).toEqual(['send_main']);
    expect(step(planning, { type: 'retry_stage' }, cfg).effects).toEqual([]);
  });

  it('brainstorm and plan modes use the planner route, and plan mode uses the plan permission mode', async () => {
    const { modeRoute } = await import('./config.ts');
    expect(modeRoute(defaultConfig(), 'chat')).toEqual({ model: undefined, effort: undefined, permissionMode: 'default' });
    expect(modeRoute(defaultConfig(), 'brainstorm')).toEqual({ model: 'opus', effort: 'high', permissionMode: 'default' });
    expect(modeRoute(defaultConfig(), 'plan')).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' });
  });
});

describe('worker permissions', () => {
  it('allows the check commands and basic git in both shells, and nothing broader', async () => {
    const { workerAllowedTools } = await import('./pipeline.ts');
    const rules = workerAllowedTools(['npm test', ' ']);
    expect(rules).toContain('Bash(npm test)');
    expect(rules).toContain('Bash(npm test:*)');
    expect(rules).toContain('PowerShell(git commit:*)');
    expect(rules).not.toContain('Bash');
    expect(rules.every((rule) => /^(Bash|PowerShell)\(.+\)$/.test(rule))).toBe(true);
    expect(rules.some((rule) => rule.includes('git push') || rule.includes('rm '))).toBe(false);
  });
});

describe('onboarding an existing project', () => {
  it('runs map, baseline, scope, audit and backlog, stopping for approval after each', async () => {
    const { ONBOARD_STAGES } = await import('./pipeline.ts');
    const cfg = config();
    let result = step(newRun(), { type: 'start_onboard' }, cfg);
    expect(result.run).toMatchObject({ kind: 'onboard', stage: 'map', status: 'working' });
    expect(result.effects).toEqual([{ type: 'send_main', prompt: '/cucicode:onboard map' }]);
    for (const stage of ONBOARD_STAGES.slice(0, -1)) {
      expect(result.run.stage).toBe(stage);
      result = step(result.run, { type: 'main_turn_done' }, cfg);
      expect(result.run).toMatchObject({ status: 'waiting', awaiting: stage });
      expect(pendingItems(result.run)[0]?.text).toContain(stage);
      result = step(result.run, { type: 'approve' }, cfg);
    }
    expect(result.run).toMatchObject({ stage: 'done', status: 'idle', awaiting: null });
  });

  it('sends a rejected stage back with the reason and can re-run a stage that stopped', () => {
    const cfg = config();
    const mapped = play([{ type: 'start_onboard' }, { type: 'main_turn_done' }], cfg).run;
    const rejected = step(mapped, { type: 'reject', reason: 'the API folder is missing' }, cfg);
    expect(rejected.run).toMatchObject({ stage: 'map', status: 'working', awaiting: null });
    expect((rejected.effects[0] as { prompt: string }).prompt).toContain('Plans/onboarding/map.md');
    expect((rejected.effects[0] as { prompt: string }).prompt).toContain('the API folder is missing');
    const stopped = step(step(newRun(), { type: 'start_onboard' }, cfg).run, { type: 'main_turn_failed', error: 'interrupted' }, cfg);
    expect(types(step(stopped.run, { type: 'retry_stage' }, cfg).effects)).toEqual(['send_main']);
  });

  it('does not treat onboarding turns as feature stages', () => {
    const cfg = config();
    const run = step(newRun(), { type: 'start_onboard' }, cfg).run;
    expect(step(run, { type: 'advance' }, cfg).effects).toEqual([]);
    expect(step(run, TWO_STORIES, cfg).effects).toEqual([]);
  });
});

describe('budget guardrails', () => {
  it('limits worker turns and downgrades the worker model near the usage limit only when enabled', async () => {
    const { workerRoute } = await import('./config.ts');
    const plain = defaultConfig();
    expect(workerRoute(plain, 99)).toEqual({ model: undefined, effort: undefined, maxTurns: undefined, downgraded: false });
    const guarded = config((value) => {
      value.routing.mode = 'predefined';
      value.budget = { maxTurnsPerTask: 40, warnAtPercent: 80, downgrade: { enabled: true, atPercent: 90, model: 'haiku' } };
    });
    expect(workerRoute(guarded, 50)).toEqual({ model: 'sonnet', effort: undefined, maxTurns: 40, downgraded: false });
    expect(workerRoute(guarded, 90)).toEqual({ model: 'haiku', effort: undefined, maxTurns: 40, downgraded: true });
    expect(workerRoute(guarded, null).downgraded).toBe(false);
  });

  it('reads budget settings from a settings file and clamps bad values', () => {
    const resolved = resolveConfig({ budget: { maxTurnsPerTask: -5, warnAtPercent: 250, downgrade: { enabled: true, model: '' } } }, null);
    expect(resolved.budget).toEqual({ maxTurnsPerTask: 0, warnAtPercent: 100, downgrade: { enabled: true, atPercent: 90, model: 'haiku' } });
  });
});

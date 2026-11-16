export const ROLES = ['main', 'planner', 'storyWriter', 'explorer', 'worker', 'reviewerLogic', 'reviewerSecurity', 'reviewerUi', 'reviewerCodeRules'] as const;
export type Role = (typeof ROLES)[number];

export const APPROVAL_STAGES = ['plan', 'stories', 'checks', 'review'] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export interface RoleRoute {
  agent: string;
  model: string;
  effort: string;
}

export interface WorkflowConfig {
  pipeline: { approvals: Record<ApprovalStage, boolean>; maxFixRounds: number };
  routing: { mode: 'auto' | 'predefined'; roles: Record<Role, RoleRoute> };
  git: {
    pushMode: 'local' | 'direct' | 'pr';
    mergeMode: 'approval' | 'auto';
    requireCi: boolean;
    maxParallelWorktrees: number;
    protectedPaths: string[];
  };
  checks: { commands: string[] };
  stories: { target: 'folder'; folder: string };
}

export const ROLE_INFO: Record<Role, { label: string; job: string; defaultAgent: string }> = {
  main: { label: 'Main thread', job: 'Conversation and orchestration', defaultAgent: '' },
  planner: { label: 'Planner', job: 'Brainstorm and plan; writes the plan to a file', defaultAgent: 'cucicode:planner' },
  storyWriter: { label: 'Story writer', job: 'Turns the plan into stories', defaultAgent: 'cucicode:story-writer' },
  explorer: { label: 'Explorer', job: 'Read-only codebase exploration', defaultAgent: 'cucicode:explorer' },
  worker: { label: 'Worker', job: 'Implements one story in its own worktree', defaultAgent: 'cucicode:worker' },
  reviewerLogic: { label: 'Reviewer: logic', job: 'Correctness of the diff', defaultAgent: 'cucicode:reviewer-logic' },
  reviewerSecurity: { label: 'Reviewer: security', job: 'Security of the diff', defaultAgent: 'cucicode:reviewer-security' },
  reviewerUi: { label: 'Reviewer: UI', job: 'Usability and accessibility of UI changes', defaultAgent: 'cucicode:reviewer-ui' },
  reviewerCodeRules: { label: 'Reviewer: code rules', job: 'The diff against the project rules', defaultAgent: 'cucicode:reviewer-code-rules' },
};

const DEFAULT_MODELS: Record<Role, [model: string, effort: string]> = {
  main: ['sonnet', ''],
  planner: ['opus', 'high'],
  storyWriter: ['sonnet', ''],
  explorer: ['haiku', ''],
  worker: ['sonnet', ''],
  reviewerLogic: ['sonnet', ''],
  reviewerSecurity: ['sonnet', ''],
  reviewerUi: ['sonnet', ''],
  reviewerCodeRules: ['sonnet', ''],
};

function defaultRoles(): Record<Role, RoleRoute> {
  return Object.fromEntries(ROLES.map((role) => [role, { agent: ROLE_INFO[role].defaultAgent, model: DEFAULT_MODELS[role][0], effort: DEFAULT_MODELS[role][1] }])) as Record<Role, RoleRoute>;
}

export const DEFAULT_PROTECTED_PATHS = ['.env*', '**/secrets/**', '**/migrations/**'];

export function defaultConfig(): WorkflowConfig {
  return {
    pipeline: { approvals: { plan: true, stories: true, checks: false, review: true }, maxFixRounds: 2 },
    routing: { mode: 'auto', roles: defaultRoles() },
    git: { pushMode: 'local', mergeMode: 'approval', requireCi: false, maxParallelWorktrees: 2, protectedPaths: [...DEFAULT_PROTECTED_PATHS] },
    checks: { commands: [] },
    stories: { target: 'folder', folder: 'Stories' },
  };
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
const pick = (source: Dict | undefined, key: string): Dict | undefined => (source && isDict(source[key]) ? (source[key] as Dict) : undefined);

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function strings(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Applies one settings file on top of a configuration, ignoring anything of the wrong type. */
function applyLayer(base: WorkflowConfig, layer: Dict | undefined): WorkflowConfig {
  if (!layer) {
    return base;
  }
  const pipeline = pick(layer, 'pipeline');
  const approvals = pick(pipeline, 'approvals');
  const routing = pick(layer, 'routing');
  const roles = pick(routing, 'roles');
  const git = pick(layer, 'git');
  const checks = pick(layer, 'checks');
  const stories = pick(layer, 'stories');
  return {
    pipeline: {
      approvals: Object.fromEntries(APPROVAL_STAGES.map((stage) => [stage, bool(approvals?.[stage], base.pipeline.approvals[stage])])) as Record<ApprovalStage, boolean>,
      maxFixRounds: int(pipeline?.maxFixRounds, base.pipeline.maxFixRounds, 0, 10),
    },
    routing: {
      mode: oneOf(routing?.mode, ['auto', 'predefined'] as const, base.routing.mode),
      roles: Object.fromEntries(
        ROLES.map((role) => {
          const route = pick(roles, role);
          const current = base.routing.roles[role];
          return [role, { agent: text(route?.agent, current.agent), model: text(route?.model, current.model), effort: text(route?.effort, current.effort) }];
        }),
      ) as Record<Role, RoleRoute>,
    },
    git: {
      pushMode: oneOf(git?.pushMode, ['local', 'direct', 'pr'] as const, base.git.pushMode),
      mergeMode: oneOf(git?.mergeMode, ['approval', 'auto'] as const, base.git.mergeMode),
      requireCi: bool(git?.requireCi, base.git.requireCi),
      maxParallelWorktrees: int(git?.maxParallelWorktrees, base.git.maxParallelWorktrees, 1, 8),
      protectedPaths: strings(git?.protectedPaths, base.git.protectedPaths),
    },
    checks: { commands: strings(checks?.commands, base.checks.commands) },
    stories: { target: 'folder', folder: text(stories?.folder, base.stories.folder) || 'Stories' },
  };
}

/** Defaults, then the project's shared file, then the personal file: the same order Claude Code uses. */
export function resolveConfig(shared: unknown, local: unknown): WorkflowConfig {
  return applyLayer(applyLayer(defaultConfig(), isDict(shared) ? shared : undefined), isDict(local) ? local : undefined);
}

/** Where a value comes from, for the "effective value and source" label. */
export function sourceOf(shared: unknown, local: unknown, section: keyof WorkflowConfig, key: string): 'default' | 'project' | 'local' {
  const has = (layer: unknown): boolean => isDict(layer) && isDict(layer[section]) && key in (layer[section] as Dict);
  return has(local) ? 'local' : has(shared) ? 'project' : 'default';
}

/**
 * What the chat switches to for a mode. Brainstorm and Plan are the planner role, so they
 * always use the planner's model and effort; Plan also uses Claude Code's plan permission mode.
 */
export function modeRoute(config: WorkflowConfig, mode: 'chat' | 'brainstorm' | 'plan'): { model: string | undefined; effort: string | undefined; permissionMode: 'default' | 'plan' } {
  if (mode === 'chat') {
    return { ...sessionRoute(config, 'main'), permissionMode: 'default' };
  }
  const planner = config.routing.roles.planner;
  return { model: planner.model || undefined, effort: planner.effort || undefined, permissionMode: mode === 'plan' ? 'plan' : 'default' };
}

/** The model and effort a session should start with for a role, or nothing when routing is automatic. */
export function sessionRoute(config: WorkflowConfig, role: Role): { model: string | undefined; effort: string | undefined } {
  if (config.routing.mode === 'auto') {
    return { model: undefined, effort: undefined };
  }
  const route = config.routing.roles[role];
  return { model: route.model || undefined, effort: route.effort || undefined };
}

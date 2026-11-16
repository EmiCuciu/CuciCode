import { create } from 'zustand';
import type { Effort, TimelineEvent } from '@cucicode/protocol';
import { workflowApi, type CheckRun, type Story, type Worktree } from '../../bridge/tauri.ts';
import { chatListeners, useApp } from '../../state/store.ts';
import { resolveConfig, sessionRoute, type WorkflowConfig } from './config.ts';
import { isUsageLimitText, newRun, pendingItems, step, workerAllowedTools, type Effect, type FeatureRun, type PipelineEvent } from './pipeline.ts';

const WORKER_SEPARATOR = '::';

export function workerChatId(projectId: string, storyId: string): string {
  return `${projectId}${WORKER_SEPARATOR}${storyId}`;
}

export function parseChatId(chatId: string): { projectId: string; storyId: string | null } {
  const index = chatId.indexOf(WORKER_SEPARATOR);
  return index === -1 ? { projectId: chatId, storyId: null } : { projectId: chatId.slice(0, index), storyId: chatId.slice(index + WORKER_SEPARATOR.length) };
}

export type CenterView = { kind: 'main' } | { kind: 'worker'; storyId: string } | { kind: 'diff'; storyId: string };

export interface ProjectWorkflow {
  raw: { shared: Record<string, unknown>; local: Record<string, unknown> };
  config: WorkflowConfig;
  stories: Story[];
  worktrees: Worktree[];
  checkCommands: string[];
  checks: Record<string, CheckRun>;
  run: FeatureRun | null;
  view: CenterView;
  notices: { ts: number; text: string }[];
}

interface WorkflowState {
  projects: Record<string, ProjectWorkflow>;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  refresh: (projectId: string) => Promise<void>;
  dispatch: (projectId: string, event: PipelineEvent) => Promise<void>;
  saveSetting: (projectId: string, local: boolean, section: string, value: unknown) => Promise<void>;
  setView: (projectId: string, view: CenterView) => void;
  clearRun: (projectId: string) => Promise<void>;
  discardWorktree: (projectId: string, storyId: string) => Promise<void>;
  dismissNotices: (projectId: string) => void;
  dismissError: () => void;
}

function projectPath(projectId: string): string {
  const project = useApp.getState().projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error(`unknown project ${projectId}`);
  }
  return project.path;
}

function lastAssistantText(chatId: string): string {
  const events = useApp.getState().chats[chatId]?.timeline.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'assistant_text' && event.parentToolUseId === null) {
      return event.text;
    }
    if (event?.kind === 'user_message' && event.parentToolUseId === null) {
      break;
    }
  }
  return '';
}

/**
 * Ends the worker's Claude Code process before its folder is removed. On Windows a
 * running process keeps its working directory locked, so the removal would fail.
 */
async function releaseWorktree(projectId: string, storyId: string): Promise<void> {
  const chatId = workerChatId(projectId, storyId);
  if (useApp.getState().chats[chatId]?.open) {
    await useApp.getState().closeChat(chatId);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

function failedOutput(run: CheckRun): string {
  const failed = run.results.find((result) => !result.passed);
  return failed ? `$ ${failed.command}\n(exit ${failed.exitCode ?? 'none'})\n\n${failed.output}` : '';
}

export const useWorkflow = create<WorkflowState>((set, get) => {
  const current = (projectId: string): ProjectWorkflow | undefined => get().projects[projectId];
  const patch = (projectId: string, change: Partial<ProjectWorkflow>): void => {
    const existing = current(projectId);
    if (existing) {
      set((state) => ({ projects: { ...state.projects, [projectId]: { ...existing, ...change } } }));
    }
  };
  const fail = (error: unknown): void => set({ error: error instanceof Error ? error.message : String(error) });

  const prepareWorker = async (projectId: string, storyId: string): Promise<string> => {
    const workflow = current(projectId);
    const path = projectPath(projectId);
    await workflowApi.commitDocs(path, `${workflow?.run?.feature ?? 'feature'}: plan and stories`);
    const worktree = await workflowApi.addWorktree(path, storyId);
    const chatId = workerChatId(projectId, storyId);
    const route = workflow ? sessionRoute(workflow.config, 'worker') : { model: undefined, effort: undefined };
    useApp.getState().configureChat(chatId, { cwd: worktree.path, model: route.model, effort: route.effort as Effort | undefined, permissionMode: 'acceptEdits', allowedTools: workerAllowedTools(workflow?.checkCommands ?? []) });
    return chatId;
  };

  const perform = async (projectId: string, effect: Effect): Promise<void> => {
    const path = projectPath(projectId);
    switch (effect.type) {
      case 'send_main':
        await useApp.getState().send(projectId, effect.prompt, [], false);
        return;
      case 'load_stories': {
        const stories = await workflowApi.stories(path);
        patch(projectId, { stories });
        const feature = current(projectId)?.run?.feature;
        const mine = stories.filter((story) => !story.archived && story.feature === feature);
        await get().dispatch(projectId, { type: 'stories_loaded', stories: mine.map((story) => ({ id: story.id, dependsOn: story.dependsOn })) });
        return;
      }
      case 'start_worker':
      case 'send_worker':
        try {
          const chatId = await prepareWorker(projectId, effect.storyId);
          await useApp.getState().send(chatId, effect.prompt, [], false);
          patch(projectId, { worktrees: await workflowApi.worktrees(path) });
        } catch (error) {
          await get().dispatch(projectId, { type: 'worker_failed', storyId: effect.storyId, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      case 'run_checks':
        try {
          const run = await workflowApi.runChecks(path, effect.storyId);
          patch(projectId, { checks: { ...current(projectId)?.checks, [effect.storyId]: run } });
          await get().dispatch(projectId, { type: 'checks_done', storyId: effect.storyId, passed: run.passed, output: failedOutput(run) });
        } catch (error) {
          await get().dispatch(projectId, { type: 'worker_failed', storyId: effect.storyId, error: `checks could not run: ${String(error)}` });
        }
        return;
      case 'merge':
        try {
          await releaseWorktree(projectId, effect.storyId);
          const pushMode = current(projectId)?.config.git.pushMode;
          if (pushMode === 'pr') {
            const opened = await workflowApi.pullRequest(path, effect.storyId);
            patch(projectId, { notices: [...(current(projectId)?.notices ?? []), { ts: Date.now(), text: `${effect.storyId}: pull request opened at ${opened.url}` }], view: { kind: 'main' } });
            await get().dispatch(projectId, { type: 'merged', storyId: effect.storyId });
            await get().refresh(projectId);
            return;
          }
          const finished = await workflowApi.finish(path, effect.storyId, pushMode === 'direct');
          const notices = finished.warnings.map((text) => ({ ts: Date.now(), text: `${effect.storyId}: ${text}` }));
          patch(projectId, { notices: [...(current(projectId)?.notices ?? []), ...notices], view: { kind: 'main' } });
          await get().dispatch(projectId, { type: 'merged', storyId: effect.storyId });
          await get().refresh(projectId);
        } catch (error) {
          await get().dispatch(projectId, { type: 'merge_failed', storyId: effect.storyId, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      case 'notify':
        patch(projectId, { notices: [...(current(projectId)?.notices ?? []), { ts: Date.now(), text: effect.text }].slice(-50) });
        return;
    }
  };

  return {
    projects: {},
    error: null,

    load: async (projectId) => {
      try {
        const path = projectPath(projectId);
        const [raw, state, stories, worktrees, checkCommands] = await Promise.all([
          workflowApi.settings(path),
          workflowApi.state(path),
          workflowApi.stories(path),
          workflowApi.worktrees(path).catch(() => []),
          workflowApi.checkCommands(path),
        ]);
        const existing = current(projectId);
        const saved = state.run as FeatureRun | undefined;
        const run = existing?.run ?? (saved && typeof saved.feature === 'string' ? { ...saved, kind: saved.kind ?? 'feature' } : null);
        set((store) => ({
          projects: {
            ...store.projects,
            [projectId]: {
              raw,
              config: resolveConfig(raw.shared, raw.local),
              stories,
              worktrees,
              checkCommands,
              checks: existing?.checks ?? {},
              run,
              view: existing?.view ?? { kind: 'main' },
              notices: existing?.notices ?? [],
            },
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    refresh: async (projectId) => {
      try {
        const path = projectPath(projectId);
        const [stories, worktrees] = await Promise.all([workflowApi.stories(path), workflowApi.worktrees(path).catch(() => [])]);
        patch(projectId, { stories, worktrees });
      } catch (error) {
        fail(error);
      }
    },

    dispatch: async (projectId, event) => {
      const workflow = current(projectId);
      if (!workflow) {
        return;
      }
      const result = step(workflow.run ?? newRun(), event, workflow.config);
      if (result.run === workflow.run && result.effects.length === 0) {
        return;
      }
      patch(projectId, { run: result.run });
      try {
        await workflowApi.saveState(projectPath(projectId), { run: result.run });
        for (const effect of result.effects) {
          await perform(projectId, effect);
        }
      } catch (error) {
        fail(error);
      }
    },

    saveSetting: async (projectId, local, section, value) => {
      try {
        await workflowApi.setSetting(projectPath(projectId), local, section, value);
        await get().load(projectId);
      } catch (error) {
        fail(error);
      }
    },

    setView: (projectId, view) => patch(projectId, { view }),

    clearRun: async (projectId) => {
      patch(projectId, { run: null, view: { kind: 'main' } });
      try {
        await workflowApi.saveState(projectPath(projectId), {});
      } catch (error) {
        fail(error);
      }
    },

    discardWorktree: async (projectId, storyId) => {
      try {
        await releaseWorktree(projectId, storyId);
        await workflowApi.removeWorktree(projectPath(projectId), storyId, true);
        patch(projectId, { view: { kind: 'main' } });
        await get().refresh(projectId);
      } catch (error) {
        fail(error);
      }
    },

    dismissNotices: (projectId) => patch(projectId, { notices: [] }),
    dismissError: () => set({ error: null }),
  };
});

const LIMIT_MESSAGE = 'the usage limit was reached; run it again after the limit resets';
const limitedChats = new Set<string>();

function onChatEvent(chatId: string, event: TimelineEvent): void {
  if (event.kind === 'rate_limit' && event.status === 'rejected') {
    limitedChats.add(chatId);
    return;
  }
  if (event.kind !== 'result') {
    return;
  }
  const hitLimit = limitedChats.delete(chatId) || isUsageLimitText(lastAssistantText(chatId));
  if (hitLimit) {
    const { projectId, storyId } = parseChatId(chatId);
    if (useWorkflow.getState().projects[projectId]?.run) {
      void useWorkflow.getState().dispatch(projectId, storyId === null ? { type: 'main_turn_failed', error: LIMIT_MESSAGE } : { type: 'worker_failed', storyId, error: LIMIT_MESSAGE });
    }
    return;
  }
  const { projectId, storyId } = parseChatId(chatId);
  const workflow = useWorkflow.getState().projects[projectId];
  if (!workflow?.run) {
    return;
  }
  const dispatch = useWorkflow.getState().dispatch;
  const error = event.errors.join('; ') || event.subtype;
  if (storyId === null) {
    void dispatch(projectId, event.isError ? { type: 'main_turn_failed', error } : { type: 'main_turn_done' });
  } else if (event.isError) {
    void dispatch(projectId, { type: 'worker_failed', storyId, error: `the worker turn stopped: ${error}` });
  } else {
    const text = lastAssistantText(chatId);
    const stage = workflow.run.stories[storyId]?.stage ?? 'work';
    const path = useApp.getState().projects.find((project) => project.id === projectId)?.path;
    const commit = path ? workflowApi.commitWorktree(path, storyId, `${storyId}: ${stage}`).catch(() => false) : Promise.resolve(false);
    void commit.then(() => dispatch(projectId, { type: 'worker_turn_done', storyId, text }));
  }
}

chatListeners.add(onChatEvent);

export interface InboxItem {
  projectId: string;
  projectName: string;
  storyId: string | null;
  text: string;
}

/** Everything waiting for the user across the projects that have been opened in this session. */
export function inboxItems(workflows: Record<string, ProjectWorkflow>, projects: { id: string; name: string }[]): InboxItem[] {
  return projects.flatMap((project) => pendingItems(workflows[project.id]?.run ?? null).map((item) => ({ projectId: project.id, projectName: project.name, ...item })));
}

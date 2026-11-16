import { create } from 'zustand';
import type {
  Attachment,
  ChatInfo,
  Effort,
  EventCategory,
  PermissionMode,
  SessionSummary,
  TimelineEvent,
} from '@cucicode/protocol';
import { projectsApi, settingsApi, sidecar } from '../bridge/tauri.ts';
import type { Project } from '../bridge/types.ts';
import { applyEvent, emptyTimeline, fromHistory, type TimelineState } from './timeline.ts';

export type ChatMode = 'chat' | 'brainstorm' | 'plan';

/** Called for every timeline event of every chat, after the store has applied it. */
export const chatListeners = new Set<(chatId: string, event: TimelineEvent) => void>();

export interface ChatState {
  timeline: TimelineState;
  open: boolean;
  /** Set for chats that do not run in the project folder itself, such as a story's worktree. */
  cwd: string | null;
  /** Permission rules granted to this session only, for example a worker's check commands. */
  allowedTools: string[];
  mode: ChatMode;
  resumeSessionId: string | null;
  info: ChatInfo | null;
  model: string | undefined;
  effort: Effort | undefined;
  permissionMode: PermissionMode;
}

const newChat = (): ChatState => ({
  timeline: emptyTimeline,
  open: false,
  cwd: null,
  allowedTools: [],
  mode: 'chat',
  resumeSessionId: null,
  info: null,
  model: undefined,
  effort: undefined,
  permissionMode: 'default',
});

interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  chats: Record<string, ChatState>;
  sessions: Record<string, SessionSummary[]>;
  hiddenCategories: Record<string, EventCategory[]>;
  error: string | null;

  loadProjects: () => Promise<void>;
  addProject: () => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  loadSessions: (projectId: string) => Promise<void>;
  viewSession: (projectId: string, sessionId: string) => Promise<void>;
  newSession: (projectId: string) => Promise<void>;
  renameSession: (projectId: string, sessionId: string, title: string) => Promise<void>;
  deleteSession: (projectId: string, sessionId: string) => Promise<void>;
  send: (projectId: string, text: string, attachments: Attachment[], interruptFirst: boolean) => Promise<void>;
  interrupt: (projectId: string) => Promise<void>;
  respondPermission: (requestId: string, behavior: 'allow' | 'deny', remember: boolean) => Promise<void>;
  setModel: (projectId: string, model: string | undefined) => Promise<void>;
  setEffort: (projectId: string, effort: Effort | undefined) => Promise<void>;
  closeChat: (chatId: string) => Promise<void>;
  configureChat: (chatId: string, patch: Partial<Pick<ChatState, 'cwd' | 'model' | 'effort' | 'permissionMode' | 'allowedTools'>>) => void;
  applyMode: (chatId: string, mode: ChatMode, route: { model: string | undefined; effort: Effort | undefined; permissionMode: PermissionMode }) => Promise<void>;
  setPermissionMode: (projectId: string, mode: PermissionMode) => Promise<void>;
  toggleCategory: (projectId: string, category: EventCategory) => Promise<void>;
  receive: (chatId: string, event: TimelineEvent) => void;
  refreshInfo: (projectId: string) => Promise<void>;
  dismissError: () => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const useApp = create<AppState>((set, get) => {
  const project = (id: string): Project => {
    const found = get().projects.find((item) => item.id === id);
    if (!found) {
      throw new Error(`unknown project ${id}`);
    }
    return found;
  };
  const chat = (id: string): ChatState => get().chats[id] ?? newChat();
  const patchChat = (id: string, patch: Partial<ChatState>): void => {
    set((state) => ({ chats: { ...state.chats, [id]: { ...(state.chats[id] ?? newChat()), ...patch } } }));
  };
  const guard = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      set({ error: message(error) });
    }
  };
  const closeChat = async (id: string): Promise<void> => {
    if (chat(id).open) {
      await sidecar('chat.close', { chatId: id });
    }
  };
  /**
   * Effort can only be set when a session starts. This ends the running process and
   * remembers the session, so the next message resumes it with the new setting.
   */
  const restartLater = async (id: string): Promise<void> => {
    const current = chat(id);
    if (!current.open) {
      return;
    }
    await sidecar('chat.close', { chatId: id });
    patchChat(id, { open: false, info: null, resumeSessionId: current.timeline.init?.sessionId ?? current.resumeSessionId });
  };
  const ensureOpen = async (id: string): Promise<void> => {
    const current = chat(id);
    if (current.open) {
      return;
    }
    await sidecar('chat.open', {
      chatId: id,
      cwd: current.cwd ?? project(id).path,
      resume: current.resumeSessionId ?? undefined,
      model: current.model,
      effort: current.effort,
      permissionMode: current.permissionMode,
      allowedTools: current.allowedTools.length > 0 ? current.allowedTools : undefined,
    });
    patchChat(id, { open: true });
  };

  return {
    projects: [],
    activeProjectId: null,
    chats: {},
    sessions: {},
    hiddenCategories: {},
    error: null,

    loadProjects: () =>
      guard(async () => {
        const projects = await projectsApi.list();
        set({ projects });
        const first = projects[0];
        if (get().activeProjectId === null && first) {
          await get().selectProject(first.id);
        }
      }),

    addProject: () =>
      guard(async () => {
        const path = await projectsApi.pickFolder();
        if (path === null) {
          return;
        }
        const added = await projectsApi.add(path);
        set((state) => ({ projects: [...state.projects.filter((item) => item.id !== added.id), added] }));
        await get().selectProject(added.id);
      }),

    removeProject: (id) =>
      guard(async () => {
        await closeChat(id);
        await projectsApi.remove(id);
        set((state) => ({
          projects: state.projects.filter((item) => item.id !== id),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
        }));
      }),

    selectProject: (id) =>
      guard(async () => {
        set({ activeProjectId: id });
        if (get().hiddenCategories[id] === undefined) {
          const ui = await settingsApi.getProjectUi(project(id).path);
          set((state) => ({ hiddenCategories: { ...state.hiddenCategories, [id]: ui.hiddenCategories } }));
        }
        await get().loadSessions(id);
      }),

    loadSessions: (projectId) =>
      guard(async () => {
        const sessions = await sidecar('sessions.list', { cwd: project(projectId).path });
        set((state) => ({ sessions: { ...state.sessions, [projectId]: sessions } }));
      }),

    viewSession: (projectId, sessionId) =>
      guard(async () => {
        await closeChat(projectId);
        const events = await sidecar('sessions.messages', { cwd: project(projectId).path, sessionId });
        patchChat(projectId, { timeline: fromHistory(events), open: false, resumeSessionId: sessionId, info: null });
      }),

    newSession: (projectId) =>
      guard(async () => {
        await closeChat(projectId);
        patchChat(projectId, { timeline: emptyTimeline, open: false, resumeSessionId: null, info: null });
      }),

    renameSession: (projectId, sessionId, title) =>
      guard(async () => {
        await sidecar('sessions.rename', { cwd: project(projectId).path, sessionId, title });
        await get().loadSessions(projectId);
      }),

    deleteSession: (projectId, sessionId) =>
      guard(async () => {
        const current = chat(projectId);
        const isCurrent = current.resumeSessionId === sessionId || current.timeline.init?.sessionId === sessionId;
        if (isCurrent) {
          await get().newSession(projectId);
        }
        await sidecar('sessions.delete', { cwd: project(projectId).path, sessionId });
        await get().loadSessions(projectId);
      }),

    send: (projectId, text, attachments, interruptFirst) =>
      guard(async () => {
        await ensureOpen(projectId);
        if (interruptFirst) {
          await sidecar('chat.interrupt', { chatId: projectId });
        }
        await sidecar('chat.send', { chatId: projectId, text, attachments });
      }),

    interrupt: (projectId) => guard(async () => void (await sidecar('chat.interrupt', { chatId: projectId }))),

    respondPermission: (requestId, behavior, remember) =>
      guard(async () => void (await sidecar('permission.respond', { requestId, behavior, remember }))),

    setModel: (projectId, model) =>
      guard(async () => {
        patchChat(projectId, { model });
        if (chat(projectId).open) {
          await sidecar('chat.setModel', { chatId: projectId, model });
        }
      }),

    setEffort: (projectId, effort) =>
      guard(async () => {
        if (chat(projectId).effort !== effort) {
          await restartLater(projectId);
          patchChat(projectId, { effort });
        }
      }),

    closeChat: (chatId) => guard(() => restartLater(chatId)),

    configureChat: (chatId, patch) => patchChat(chatId, patch),

    applyMode: (chatId, mode, route) =>
      guard(async () => {
        const current = chat(chatId);
        if (current.effort !== route.effort) {
          await restartLater(chatId);
        } else if (current.open) {
          if (current.model !== route.model) {
            await sidecar('chat.setModel', { chatId, model: route.model });
          }
          if (current.permissionMode !== route.permissionMode) {
            await sidecar('chat.setPermissionMode', { chatId, mode: route.permissionMode });
          }
        }
        patchChat(chatId, { mode, ...route });
      }),

    setPermissionMode: (projectId, mode) =>
      guard(async () => {
        patchChat(projectId, { permissionMode: mode });
        if (chat(projectId).open) {
          await sidecar('chat.setPermissionMode', { chatId: projectId, mode });
        }
      }),

    toggleCategory: (projectId, category) =>
      guard(async () => {
        const current = get().hiddenCategories[projectId] ?? [];
        const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category];
        set((state) => ({ hiddenCategories: { ...state.hiddenCategories, [projectId]: next } }));
        await settingsApi.setProjectUi(project(projectId).path, { hiddenCategories: next });
      }),

    receive: (chatId, event) => {
      patchChat(chatId, { timeline: applyEvent(chat(chatId).timeline, event) });
      if (event.kind === 'result') {
        void get().refreshInfo(chatId);
        if (get().projects.some((item) => item.id === chatId)) {
          void get().loadSessions(chatId);
        }
      }
      for (const listener of chatListeners) {
        listener(chatId, event);
      }
    },

    refreshInfo: (projectId) =>
      guard(async () => {
        if (chat(projectId).open) {
          patchChat(projectId, { info: await sidecar('chat.info', { chatId: projectId }) });
        }
      }),

    dismissError: () => set({ error: null }),
  };
});

export const selectChat = (projectId: string | null) => (state: AppState): ChatState | null =>
  projectId === null ? null : (state.chats[projectId] ?? null);

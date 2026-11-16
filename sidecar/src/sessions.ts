import {
  deleteSession,
  forkSession,
  getSessionMessages,
  listSessions,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { MethodParams, SessionSummary, TimelineEvent } from '@cucicode/protocol';
import { normalizeMessage } from './normalize.ts';

export async function listProjectSessions(params: MethodParams<'sessions.list'>): Promise<SessionSummary[]> {
  const sessions = await listSessions({ dir: params.cwd, limit: params.limit });
  return sessions
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
      firstPrompt: session.firstPrompt ?? null,
      lastModified: session.lastModified,
      createdAt: session.createdAt ?? null,
      gitBranch: session.gitBranch ?? null,
      fileSize: session.fileSize ?? null,
    }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

export async function loadSessionEvents(params: MethodParams<'sessions.messages'>): Promise<TimelineEvent[]> {
  const messages = await getSessionMessages(params.sessionId, { dir: params.cwd });
  const ctx = { source: 'history' as const, now: () => null };
  return messages.flatMap((message) => normalizeMessage(message, ctx));
}

export async function renameProjectSession(params: MethodParams<'sessions.rename'>): Promise<void> {
  await renameSession(params.sessionId, params.title, { dir: params.cwd });
}

export async function deleteProjectSession(params: MethodParams<'sessions.delete'>): Promise<void> {
  await deleteSession(params.sessionId, { dir: params.cwd });
}

export async function forkProjectSession(params: MethodParams<'sessions.fork'>): Promise<{ sessionId: string }> {
  const result = await forkSession(params.sessionId, { dir: params.cwd });
  return { sessionId: result.sessionId };
}

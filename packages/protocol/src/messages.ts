import type { TimelineEvent } from './events.ts';

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstPrompt: string | null;
  lastModified: number;
  createdAt: number | null;
  gitBranch: string | null;
  fileSize: number | null;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  effortLevels: string[];
  /** The concrete model a name such as "default" resolves to, when Claude Code reports it. */
  resolvedModel: string | null;
}

export interface CommandOption {
  name: string;
  description: string;
  argumentHint: string;
  builtin: boolean;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
}

export interface ChatInfo {
  models: ModelOption[];
  commands: CommandOption[];
  subscriptionType: string | null;
  authSource: string | null;
  context: ContextUsage | null;
  outputStyle: string | null;
  outputStyles: string[];
}

/** What rewinding files to a user message would change, or did change. */
export interface RewindResult {
  canRewind: boolean;
  error: string | null;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface ReadyMessage {
  type: 'ready';
  protocolVersion: number;
  sdkVersion: string;
}

export interface ResponseMessage {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  type: 'event';
  chatId: string;
  event: TimelineEvent;
}

export interface LogMessage {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export type SidecarMessage = ReadyMessage | ResponseMessage | EventMessage | LogMessage;

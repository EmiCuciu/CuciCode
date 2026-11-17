import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, ChatInfo, MethodParams, RewindResult } from '@cucicode/protocol';
import { AsyncQueue } from './asyncQueue.ts';
import { buildAgentEnv } from './env.ts';
import { normalizeMessage } from './normalize.ts';
import type { ChatEmit, PermissionBroker } from './permissions.ts';

type ContentBlock = Record<string, unknown>;

/** The only skills a pipeline worker needs; every other skill is left out of its context. */
const LEAN_SKILLS = ['cucicode:build', 'cucicode:fix', 'cucicode:review'] as const;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function attachmentToBlock(attachment: Attachment): ContentBlock {
  if (IMAGE_TYPES.has(attachment.mediaType)) {
    return { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.dataBase64 } };
  }
  if (attachment.mediaType === 'application/pdf') {
    return {
      type: 'document',
      title: attachment.name,
      source: { type: 'base64', media_type: attachment.mediaType, data: attachment.dataBase64 },
    };
  }
  const text = Buffer.from(attachment.dataBase64, 'base64').toString('utf8');
  return { type: 'document', title: attachment.name, source: { type: 'text', media_type: 'text/plain', data: text } };
}

export class ChatSession {
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly query: Query;
  private closed = false;
  /** Ids of messages sent from the UI that Claude Code has not echoed back yet, oldest first. */
  private readonly unconfirmed: string[] = [];
  /** UI message id to the id Claude Code gave that message, which file checkpoints are keyed by. */
  private readonly checkpointIds = new Map<string, string>();

  constructor(
    private readonly params: MethodParams<'chat.open'>,
    private readonly emit: ChatEmit,
    private readonly broker: PermissionBroker,
    private readonly log: (message: string) => void,
  ) {
    this.query = query({
      prompt: this.input,
      options: {
        cwd: params.cwd,
        resume: params.resume,
        forkSession: params.forkSession,
        model: params.model,
        effort: params.effort,
        permissionMode: params.permissionMode,
        allowedTools: params.allowedTools,
        maxTurns: params.maxTurns,
        canUseTool: broker.canUseToolFor(params.chatId),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(params.lean ? { strictMcpConfig: true, skills: [...LEAN_SKILLS] } : {}),
        includePartialMessages: true,
        enableFileCheckpointing: true,
        extraArgs: { 'replay-user-messages': null },
        includeHookEvents: true,
        forwardSubagentText: true,
        env: buildAgentEnv(process.env, params.env),
        stderr: (data) => this.log(`[${params.chatId}] ${data.trimEnd()}`),
      },
    });
    void this.pump();
  }

  send(params: MethodParams<'chat.send'>): void {
    const attachments = params.attachments ?? [];
    const content: ContentBlock[] = attachments.map(attachmentToBlock);
    if (params.text.length > 0) {
      content.push({ type: 'text', text: params.text });
    }
    const uuid = randomUUID();
    this.emit(this.params.chatId, {
      kind: 'user_message',
      id: uuid,
      ts: Date.now(),
      category: 'message',
      parentToolUseId: null,
      text: params.text,
      attachmentCount: attachments.length,
    });
    this.unconfirmed.push(uuid);
    this.input.push({
      type: 'user',
      message: { role: 'user', content: attachments.length > 0 ? content : params.text },
      parent_tool_use_id: null,
      priority: params.priority,
      uuid,
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query.setModel(model);
  }

  async setPermissionMode(mode: MethodParams<'chat.setPermissionMode'>['mode']): Promise<void> {
    await this.query.setPermissionMode(mode);
  }

  /** Restores files Claude edited to their state when the given user message was sent. */
  async rewind(messageId: string, dryRun: boolean): Promise<RewindResult> {
    const result = await this.query.rewindFiles(this.checkpointIds.get(messageId) ?? messageId, { dryRun });
    return {
      canRewind: result.canRewind,
      error: result.error ?? null,
      filesChanged: result.filesChanged ?? [],
      insertions: result.insertions ?? 0,
      deletions: result.deletions ?? 0,
    };
  }

  async info(): Promise<ChatInfo> {
    const [models, commands, account, context, init] = await Promise.all([
      this.query.supportedModels(),
      this.query.supportedCommands(),
      this.query.accountInfo(),
      this.query.getContextUsage().catch(() => null),
      this.query.initializationResult().catch(() => null),
    ]);
    return {
      models: models.map((model) => ({
        value: model.value,
        displayName: model.displayName,
        description: model.description,
        effortLevels: model.supportedEffortLevels ?? [],
        resolvedModel: model.resolvedModel ?? null,
      })),
      commands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        builtin: command.builtin === true,
      })),
      subscriptionType: account.subscriptionType ?? null,
      authSource: account.tokenSource ?? account.apiKeySource ?? null,
      context: context
        ? { usedTokens: context.totalTokens, maxTokens: context.rawMaxTokens, percentage: context.percentage }
        : null,
      outputStyle: init?.output_style ?? null,
      outputStyles: init?.available_output_styles ?? [],
    };
  }

  /** Same path as /output-style: written to the project's local settings and applied from the next message. */
  async setOutputStyle(style: string): Promise<void> {
    await this.query.updateSettings('localSettings', { outputStyle: style });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.broker.cancelChat(this.params.chatId);
    this.input.close();
    this.query.close();
  }

  /** Claude Code echoes each user message with its own id; pair it with the message the UI sent. */
  private noteReplay(message: unknown): void {
    const replay = message as { type?: string; isReplay?: boolean; uuid?: string; parent_tool_use_id?: string | null; isSynthetic?: boolean };
    if (replay.type !== 'user' || replay.isReplay !== true || replay.parent_tool_use_id || replay.isSynthetic === true || typeof replay.uuid !== 'string') {
      return;
    }
    const local = this.unconfirmed.shift();
    if (local !== undefined) {
      this.checkpointIds.set(local, replay.uuid);
    }
  }

  private async pump(): Promise<void> {
    const ctx = { source: 'live' as const, now: () => Date.now() };
    try {
      for await (const message of this.query) {
        this.noteReplay(message);
        for (const event of normalizeMessage(message, ctx)) {
          this.emit(this.params.chatId, event);
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.emit(this.params.chatId, {
          kind: 'notice',
          id: randomUUID(),
          ts: Date.now(),
          category: 'system',
          parentToolUseId: null,
          level: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.emit(this.params.chatId, {
        kind: 'session_state',
        id: randomUUID(),
        ts: Date.now(),
        category: 'system',
        parentToolUseId: null,
        state: 'idle',
      });
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { MethodParams, TimelineEvent } from '@cucicode/protocol';

interface Pending {
  chatId: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[] | undefined;
  resolve: (result: PermissionResult) => void;
}

export type ChatEmit = (chatId: string, event: TimelineEvent) => void;

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly emit: ChatEmit) {}

  canUseToolFor(chatId: string): CanUseTool {
    return (toolName, input, options) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = randomUUID();
        const suggestions = options.suggestions;
        this.pending.set(requestId, { chatId, input, suggestions, resolve });
        options.signal.addEventListener(
          'abort',
          () => {
            if (this.pending.delete(requestId)) {
              this.emitResolved(chatId, requestId, 'cancelled');
              resolve({ behavior: 'deny', message: 'Permission request cancelled' });
            }
          },
          { once: true },
        );
        this.emit(chatId, {
          kind: 'permission_request',
          id: requestId,
          ts: Date.now(),
          category: 'permission',
          parentToolUseId: null,
          requestId,
          toolName,
          input,
          title: options.title ?? null,
          description: options.description ?? options.decisionReason ?? null,
          canRemember: (suggestions?.length ?? 0) > 0,
        });
      });
  }

  respond(params: MethodParams<'permission.respond'>): void {
    const entry = this.pending.get(params.requestId);
    if (!entry) {
      throw new Error(`no pending permission request ${params.requestId}`);
    }
    this.pending.delete(params.requestId);
    if (params.behavior === 'allow') {
      entry.resolve({
        behavior: 'allow',
        updatedInput: entry.input,
        ...(params.remember && entry.suggestions ? { updatedPermissions: entry.suggestions } : {}),
      });
      this.emitResolved(entry.chatId, params.requestId, 'allowed');
    } else {
      entry.resolve({ behavior: 'deny', message: params.message ?? 'Denied by the user' });
      this.emitResolved(entry.chatId, params.requestId, 'denied');
    }
  }

  cancelChat(chatId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.chatId === chatId) {
        this.pending.delete(requestId);
        entry.resolve({ behavior: 'deny', message: 'Chat closed' });
      }
    }
  }

  private emitResolved(chatId: string, requestId: string, outcome: 'allowed' | 'denied' | 'cancelled'): void {
    this.emit(chatId, {
      kind: 'permission_resolved',
      id: `${requestId}:resolved`,
      ts: Date.now(),
      category: 'permission',
      parentToolUseId: null,
      requestId,
      outcome,
    });
  }
}

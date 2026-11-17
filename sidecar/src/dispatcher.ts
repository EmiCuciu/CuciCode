import {
  isMethod,
  methodSchemas,
  requestEnvelopeSchema,
  type Method,
  type MethodParams,
} from '@cucicode/protocol';
import { ChatSession } from './chat.ts';
import { PermissionBroker } from './permissions.ts';
import {
  deleteProjectSession,
  forkProjectSession,
  listProjectSessions,
  loadSessionEvents,
  renameProjectSession,
} from './sessions.ts';
import type { Emit } from './transport.ts';

type Handlers = { [M in Method]: (params: MethodParams<M>) => unknown | Promise<unknown> };

export class Dispatcher {
  private readonly chats = new Map<string, ChatSession>();
  private readonly broker: PermissionBroker;
  private readonly handlers: Handlers;

  constructor(private readonly emit: Emit) {
    this.broker = new PermissionBroker((chatId, event) => emit({ type: 'event', chatId, event }));
    this.handlers = {
      ping: () => 'pong',
      'chat.open': (params) => {
        this.chats.get(params.chatId)?.close();
        const session = new ChatSession(
          params,
          (chatId, event) => emit({ type: 'event', chatId, event }),
          this.broker,
          (message) => emit({ type: 'log', level: 'debug', message }),
        );
        this.chats.set(params.chatId, session);
      },
      'chat.send': (params) => this.chat(params.chatId).send(params),
      'chat.interrupt': (params) => this.chat(params.chatId).interrupt(),
      'chat.setModel': (params) => this.chat(params.chatId).setModel(params.model),
      'chat.setPermissionMode': (params) => this.chat(params.chatId).setPermissionMode(params.mode),
      'chat.info': (params) => this.chat(params.chatId).info(),
      'chat.setOutputStyle': (params) => this.chat(params.chatId).setOutputStyle(params.style),
      'chat.rewind': (params) => this.chat(params.chatId).rewind(params.messageId, params.dryRun),
      'chat.close': (params) => {
        this.chats.get(params.chatId)?.close();
        this.chats.delete(params.chatId);
      },
      'permission.respond': (params) => this.broker.respond(params),
      'sessions.list': listProjectSessions,
      'sessions.messages': loadSessionEvents,
      'sessions.rename': renameProjectSession,
      'sessions.delete': deleteProjectSession,
      'sessions.fork': forkProjectSession,
    };
  }

  async handleLine(line: string): Promise<void> {
    let id = 'unknown';
    try {
      const envelope = requestEnvelopeSchema.parse(JSON.parse(line));
      id = envelope.id;
      if (!isMethod(envelope.method)) {
        throw new Error(`unknown method ${envelope.method}`);
      }
      const result = await this.invoke(envelope.method, envelope.params ?? {});
      this.emit({ type: 'response', id, ok: true, result: result ?? null });
    } catch (error) {
      this.emit({ type: 'response', id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  closeAll(): void {
    for (const chat of this.chats.values()) {
      chat.close();
    }
    this.chats.clear();
  }

  private invoke<M extends Method>(method: M, rawParams: unknown): unknown {
    const params = methodSchemas[method].parse(rawParams) as MethodParams<M>;
    return this.handlers[method](params);
  }

  private chat(chatId: string): ChatSession {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new Error(`chat ${chatId} is not open`);
    }
    return chat;
  }
}

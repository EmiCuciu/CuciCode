import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SidecarMessage } from '@cucicode/protocol';

const cwd = mkdtempSync(join(tmpdir(), 'cucicode-rewind-'));
const target = join(cwd, 'note.txt');
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 0;
const waiting = new Map<string, (message: Extract<SidecarMessage, { type: 'response' }>) => void>();
const request = (method: string, params: unknown): Promise<Extract<SidecarMessage, { type: 'response' }>> => {
  nextId += 1;
  const id = String(nextId);
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
};
const finish = (code: number): void => {
  child.stdin.end();
  setTimeout(() => process.exit(code), 500);
};
setTimeout(() => {
  console.error('rewind-smoke: timed out');
  finish(1);
}, 180_000);

let userMessageId: string | null = null;

for await (const line of createInterface({ input: child.stdout })) {
  const message = JSON.parse(line) as SidecarMessage;
  if (message.type === 'ready') {
    void request('chat.open', { chatId: 'rewind', cwd, permissionMode: 'acceptEdits' });
    void request('chat.send', { chatId: 'rewind', text: 'Use the Write tool to create the file note.txt containing exactly the word hello. Then reply done.' });
  } else if (message.type === 'log') {
    console.log(`log: ${message.message.slice(0, 160)}`);
  } else if (message.type === 'response') {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  } else if (message.type === 'event') {
    const event = message.event;
    if (event.kind === 'user_message' && event.parentToolUseId === null) {
      userMessageId = event.id;
    } else if (event.kind === 'permission_request') {
      console.log(`permission requested for ${event.toolName}: ${event.description ?? event.title ?? ''}; allowing`);
      void request('permission.respond', { requestId: event.requestId, behavior: 'allow' });
    } else if (event.kind === 'result' && userMessageId !== null) {
      console.log(`turn finished: ${event.subtype}; file exists after the turn: ${existsSync(target)}`);
      const messageId = userMessageId;
      // Not awaited here: the responses arrive through this same loop.
      void (async () => {
        const preview = await request('chat.rewind', { chatId: 'rewind', messageId, dryRun: true });
        console.log(`dry run: ${JSON.stringify(preview.ok ? preview.result : preview.error)}`);
        console.log(`file still exists after the dry run: ${existsSync(target)}`);
        const applied = await request('chat.rewind', { chatId: 'rewind', messageId, dryRun: false });
        console.log(`rewind: ${JSON.stringify(applied.ok ? applied.result : applied.error)}`);
        console.log(`file exists after the rewind: ${existsSync(target)}`);
        finish(existsSync(target) ? 1 : 0);
      })();
    }
  }
}

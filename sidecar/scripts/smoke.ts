import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SidecarMessage } from '@cucicode/protocol';

const cwd = process.argv[2] ?? process.cwd();
const prompt = process.argv[3] ?? 'Reply with exactly: OK';
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 0;
const send = (method: string, params: unknown): void => {
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ id: String(nextId), method, params })}\n`);
};

const finish = (code: number): void => {
  child.stdin.end();
  setTimeout(() => process.exit(code), 500);
};

const timeout = setTimeout(() => {
  console.error('smoke: timed out');
  finish(1);
}, 120_000);

let draft = '';
let infoRequested = false;

for await (const line of createInterface({ input: child.stdout })) {
  const message = JSON.parse(line) as SidecarMessage;
  if (message.type === 'ready') {
    console.log(`ready: protocol ${message.protocolVersion}, sdk ${message.sdkVersion}`);
    send('chat.open', { chatId: 'smoke', cwd, permissionMode: 'default' });
    send('chat.send', { chatId: 'smoke', text: prompt });
  } else if (message.type === 'response') {
    if (!message.ok) {
      console.log(`response ${message.id} FAILED: ${message.error}`);
    } else if (message.result !== null && typeof message.result === 'object') {
      const info = message.result as { models: { value: string }[]; commands: { name: string }[]; subscriptionType: string | null; context: unknown };
      console.log(`info: ${info.models.length} models [${info.models.map((m) => m.value).join(', ')}]`);
      console.log(`info: ${info.commands.length} commands, subscription=${info.subscriptionType}, context=${JSON.stringify(info.context)}`);
      clearTimeout(timeout);
      finish(0);
    }
  } else if (message.type === 'log') {
    console.log(`log[${message.level}]: ${message.message.slice(0, 200)}`);
  } else {
    const event = message.event;
    if (event.kind === 'stream_delta') {
      draft += event.text;
      continue;
    }
    if (event.kind === 'system_init') {
      console.log(`init: model=${event.model} auth=${event.authSource} mode=${event.permissionMode} style=${event.outputStyle} tools=${event.tools.length} commands=${event.slashCommands.length} skills=${event.skills.length}`);
    } else if (event.kind === 'assistant_text') {
      console.log(`assistant: ${event.text}  (streamed draft: ${JSON.stringify(draft)})`);
    } else if (event.kind === 'permission_request') {
      console.log(`permission requested for ${event.toolName}; denying`);
      send('permission.respond', { requestId: event.requestId, behavior: 'deny' });
    } else if (event.kind === 'result') {
      console.log(`result: ${event.subtype} turns=${event.numTurns} models=${Object.keys(event.modelUsage).join(',')}`);
      if (!infoRequested) {
        infoRequested = true;
        send('chat.info', { chatId: 'smoke' });
      }
    } else {
      console.log(`event: ${event.kind} [${event.category}]${'text' in event ? ` ${String(event.text).slice(0, 80)}` : ''}${'status' in event ? ` ${String(event.status)}` : ''}${'state' in event ? ` ${event.state}` : ''}`);
    }
  }
}

import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION } from '@cucicode/protocol';
import { Dispatcher } from './dispatcher.ts';
import { createEmitter, readLines } from './transport.ts';

function sdkVersion(): string {
  try {
    const manifest = new URL('./package.json', import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const emit = createEmitter(process.stdout);
const dispatcher = new Dispatcher(emit);

process.on('uncaughtException', (error) => {
  emit({ type: 'log', level: 'error', message: `uncaught: ${error.stack ?? error.message}` });
});
process.on('unhandledRejection', (reason) => {
  emit({ type: 'log', level: 'error', message: `unhandled rejection: ${String(reason)}` });
});

emit({ type: 'ready', protocolVersion: PROTOCOL_VERSION, sdkVersion: sdkVersion() });

await readLines(process.stdin, (line) => {
  void dispatcher.handleLine(line);
});

dispatcher.closeAll();
process.exit(0);

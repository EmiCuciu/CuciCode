import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SidecarMessage } from '@cucicode/protocol';

export type Emit = (message: SidecarMessage) => void;

export function createEmitter(output: Writable): Emit {
  return (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
}

export async function readLines(input: Readable, onLine: (line: string) => void): Promise<void> {
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      onLine(trimmed);
    }
  }
}

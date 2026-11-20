import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delegationContext } from './delegation.mjs';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.stdout.write(JSON.stringify(delegationContext(pluginRoot)));
} catch {
  process.exit(0);
}

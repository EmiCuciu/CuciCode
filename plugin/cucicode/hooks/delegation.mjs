import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DELEGATION_RULE_FILE = join('rules', 'delegation.md');

export function delegationContext(pluginRoot) {
  const rule = readFileSync(join(pluginRoot, DELEGATION_RULE_FILE), 'utf8').trim();
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rule } };
}

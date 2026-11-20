import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegationContext } from './delegation.mjs';

const hooksDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(hooksDir, '..');

function pluginWithRule(text) {
  const root = mkdtempSync(join(tmpdir(), 'cucicode-delegation-'));
  mkdirSync(join(root, 'rules'));
  writeFileSync(join(root, 'rules', 'delegation.md'), text);
  return root;
}

test('the rule file becomes SessionStart context without surrounding whitespace', () => {
  const output = delegationContext(pluginWithRule('  delegate everything\n\n'));
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(output.hookSpecificOutput.additionalContext, 'delegate everything');
});

test('a missing rule file is an error the entry script can swallow', () => {
  assert.throws(() => delegationContext(join(tmpdir(), 'cucicode-no-such-plugin')));
});

test('the shipped rule asks first, delegates to workers and keeps the heavy roles opt-in', () => {
  const { additionalContext } = delegationContext(pluginRoot).hookSpecificOutput;
  assert.ok(additionalContext.includes('at most three short questions'));
  assert.ok(additionalContext.includes('delegate each to cucicode:worker'));
  for (const role of ['cucicode:planner', 'cucicode:story-writer', 'cucicode:tester', 'cucicode:reviewer-*']) {
    assert.ok(additionalContext.includes(role), role);
  }
  assert.ok(additionalContext.includes('unless the user asks for them'));
  assert.ok(additionalContext.includes('git init -b main'));
});

test('the entry script prints the context as JSON and exits cleanly', () => {
  const stdout = execFileSync('node', [join(hooksDir, 'inject-delegation.mjs')], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: '{}',
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(stdout), delegationContext(pluginRoot));
});

test('the entry script stays silent when the rule file is missing', () => {
  const stdout = execFileSync('node', [join(hooksDir, 'inject-delegation.mjs')], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(tmpdir(), 'cucicode-no-such-plugin') },
    input: '{}',
    encoding: 'utf8',
  });
  assert.equal(stdout, '');
});

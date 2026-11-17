import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideRules, findSecret, parseEnvValues, writtenText } from './rules.mjs';

const script = fileURLToPath(new URL('./code-rules.mjs', import.meta.url));
const FAKE_GITHUB = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE';

function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cucicode-rules-'));
  mkdirSync(join(dir, '.claude', 'cucicode'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const write = (dir, file, content) => ({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, file), content } });

test('collects the text of Write, Edit, MultiEdit and NotebookEdit', () => {
  assert.equal(writtenText({ content: 'a' }), 'a');
  assert.equal(writtenText({ new_string: 'b', old_string: 'x' }), 'b');
  assert.equal(writtenText({ edits: [{ new_string: 'c' }, { new_string: 'd' }] }), 'c\nd');
  assert.equal(writtenText({ new_source: 'e' }), 'e');
  assert.equal(writtenText(null), '');
});

test('recognises common credential formats and ignores ordinary code', () => {
  assert.equal(findSecret(`const token = "${FAKE_GITHUB}";`), 'a GitHub token');
  assert.equal(findSecret(`aws_key = ${FAKE_AWS}`), 'an AWS access key');
  assert.equal(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), 'a private key');
  assert.equal(findSecret('const password = "hunter2hunter2xyz";'), 'a password or secret assigned in code');
  assert.equal(findSecret('const password = process.env.DB_PASSWORD;'), null);
  assert.equal(findSecret('const apiKey = config.get("apiKey");'), null);
  assert.equal(findSecret('password: "${DB_PASSWORD}"'), null);
  assert.equal(findSecret('function getToken() { return "short"; }'), null);
});

test('reads env values and skips comments, placeholders and short values', () => {
  const values = parseEnvValues('# comment\nDB_URL="postgres://u:pw@host/db"\nexport API_KEY=abcdef123456 # inline\nPORT=8080\nSECRET=changeme\nEMPTY=\nNAME=\'quoted value\'\n');
  assert.deepEqual(values, [
    { key: 'DB_URL', value: 'postgres://u:pw@host/db' },
    { key: 'API_KEY', value: 'abcdef123456' },
    { key: 'NAME', value: 'quoted value' },
  ]);
});

test('blocks secrets and inlined env values, allows clean code', () => {
  const dir = project({ '.env': 'DB_URL=postgres://admin:s3cret@db.internal/app\n', '.env.example': 'DB_URL=postgres://user:password@localhost/app\n' });
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.match(decideRules(write(dir, 'src/a.ts', `const t = "${FAKE_GITHUB}";`), env), /GitHub token/);
  assert.match(decideRules(write(dir, 'src/db.ts', 'connect("postgres://admin:s3cret@db.internal/app")'), env), /DB_URL from \.env/);
  assert.equal(decideRules(write(dir, 'src/db.ts', 'connect("postgres://user:password@localhost/app")'), env), null, 'values from .env.example are not secrets');
  assert.equal(decideRules(write(dir, 'src/db.ts', 'connect(process.env.DB_URL)'), env), null);
  assert.equal(decideRules({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }, env), null);
  assert.equal(decideRules(write(dir, '../outside.ts', `"${FAKE_GITHUB}"`), env), null, 'files outside the project are not checked');
  rmSync(dir, { recursive: true, force: true });
});

test('blocks writing a .env file that git would not ignore', () => {
  const dir = project();
  mkdirSync(join(dir, '.git'));
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.match(decideRules(write(dir, '.env', 'A=1'), env, () => false), /not ignored by git/);
  assert.equal(decideRules(write(dir, '.env', 'A=1'), env, () => true), null);
  assert.equal(decideRules(write(dir, '.env.example', 'A=1'), env, () => false), null, 'templates may be committed');
  assert.equal(decideRules(write(dir, '.env', `KEY=${FAKE_GITHUB}`), env, () => true), null, 'a secret belongs in an ignored .env file');
  rmSync(dir, { recursive: true, force: true });
});

test('each check can be turned off in the project settings, and the personal file wins', () => {
  const dir = project();
  writeFileSync(join(dir, '.claude', 'cucicode', 'settings.json'), JSON.stringify({ codeRules: { enforce: { secrets: false } } }));
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.equal(decideRules(write(dir, 'a.ts', `"${FAKE_GITHUB}"`), env), null);
  writeFileSync(join(dir, '.claude', 'cucicode', 'settings.local.json'), JSON.stringify({ codeRules: { enforce: { secrets: true } } }));
  assert.match(decideRules(write(dir, 'a.ts', `"${FAKE_GITHUB}"`), env), /GitHub token/);
  rmSync(dir, { recursive: true, force: true });
});

test('the hook script exits 2 with the reason and 0 otherwise, including on bad input', () => {
  const dir = project();
  const run = (input) => spawnSync(process.execPath, [script], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  const blocked = run(JSON.stringify(write(dir, 'a.ts', `key = "${FAKE_AWS}"`)));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /AWS access key/);
  assert.equal(run(JSON.stringify(write(dir, 'a.ts', 'const x = 1;'))).status, 0);
  assert.equal(run('not json').status, 0);
  rmSync(dir, { recursive: true, force: true });
});

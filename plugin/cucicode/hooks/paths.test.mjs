import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, firstMatch, matchesGlob, relativeTarget } from './paths.mjs';

const script = fileURLToPath(new URL('./protect-paths.mjs', import.meta.url));

function project(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cucicode-hook-'));
  mkdirSync(join(dir, '.claude', 'cucicode'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(dir, '.claude', 'cucicode', 'settings.json'), JSON.stringify(settings));
  }
  return dir;
}

test('globs match the way .gitignore patterns do', () => {
  assert.equal(matchesGlob('.env*', '.env'), true);
  assert.equal(matchesGlob('.env*', '.env.local'), true);
  assert.equal(matchesGlob('.env*', 'apps/api/.env.production'), true);
  assert.equal(matchesGlob('.env*', 'src/environment.ts'), false);
  assert.equal(matchesGlob('**/secrets/**', 'secrets/key.pem'), true);
  assert.equal(matchesGlob('**/secrets/**', 'config/secrets/prod/key.pem'), true);
  assert.equal(matchesGlob('**/secrets/**', 'src/secretsmanager.ts'), false);
  assert.equal(matchesGlob('**/migrations/**', 'db/migrations/001_init.sql'), true);
  assert.equal(matchesGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchesGlob('src/*.ts', 'src/deep/a.ts'), false);
  assert.equal(matchesGlob('docs/v?.md', 'docs/v2.md'), true);
  assert.equal(matchesGlob('a+b(1).txt', 'a+b(1).txt'), true);
  assert.equal(matchesGlob('', 'anything'), false);
});

test('windows separators and case are normalised', () => {
  assert.equal(matchesGlob('**/Migrations/**', 'db\\migrations\\001.sql'), true);
  assert.equal(firstMatch(['*.pem', '.env*'], 'certs\\Server.PEM'), '*.pem');
  assert.equal(firstMatch(['*.pem'], 'README.md'), null);
});

test('targets outside the project are not the hook\'s concern', () => {
  const dir = project();
  assert.equal(relativeTarget(dir, dir, join(dir, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(relativeTarget(dir, join(dir, 'src'), 'a.ts'), 'src/a.ts');
  assert.equal(relativeTarget(dir, dir, join(dir, '..', 'elsewhere.txt')), null);
  rmSync(dir, { recursive: true, force: true });
});

test('decide blocks protected files and allows the rest', () => {
  const dir = project({ git: { protectedPaths: ['.env*', '**/migrations/**'] } });
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.match(decide({ cwd: dir, tool_input: { file_path: join(dir, '.env.local') } }, env), /protected path/);
  assert.match(decide({ cwd: dir, tool_input: { notebook_path: 'db/migrations/x.ipynb' } }, env), /migrations/);
  assert.equal(decide({ cwd: dir, tool_input: { file_path: join(dir, 'src', 'app.ts') } }, env), null);
  assert.equal(decide({ cwd: dir, tool_input: { command: 'ls' } }, env), null);
  rmSync(dir, { recursive: true, force: true });
});

test('personal settings add patterns, and missing or broken settings allow everything', () => {
  const dir = project({ git: { protectedPaths: ['a.txt'] } });
  writeFileSync(join(dir, '.claude', 'cucicode', 'settings.local.json'), JSON.stringify({ git: { protectedPaths: ['b.txt'] } }));
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.notEqual(decide({ cwd: dir, tool_input: { file_path: 'a.txt' } }, env), null);
  assert.notEqual(decide({ cwd: dir, tool_input: { file_path: 'b.txt' } }, env), null);
  writeFileSync(join(dir, '.claude', 'cucicode', 'settings.json'), '{broken');
  assert.equal(decide({ cwd: dir, tool_input: { file_path: 'a.txt' } }, env), null);
  const empty = project();
  assert.equal(decide({ cwd: empty, tool_input: { file_path: '.env' } }, { CLAUDE_PROJECT_DIR: empty }), null);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test('the hook script exits 2 with a reason on stderr, and 0 otherwise', () => {
  const dir = project({ git: { protectedPaths: ['.env*'] } });
  const run = (event) => spawnSync(process.execPath, [script], { input: JSON.stringify(event), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  const blocked = run({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, '.env') } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /protected path/);
  assert.equal(run({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'README.md') } }).status, 0);
  const garbage = spawnSync(process.execPath, [script], { input: 'not json', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  rmSync(dir, { recursive: true, force: true });
});

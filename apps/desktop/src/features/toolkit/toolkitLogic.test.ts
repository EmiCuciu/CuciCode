import { describe, expect, it } from 'vitest';
import type { ToolkitItem } from '../../bridge/types.ts';
import { buildMenu, filterMenu, slashQuery } from '../chat/slashCommands.ts';
import { appendHook, removeHook } from './hooks.ts';
import { buildMcp, emptyMcpForm, secretName, splitArgs, validateMcp } from './mcp.ts';
import { countByKind, filterItems } from './toolkitStore.ts';

const item = (partial: Partial<ToolkitItem>): ToolkitItem => ({
  id: partial.name ?? 'id',
  kind: 'skill',
  scope: 'user',
  name: 'x',
  description: null,
  model: null,
  path: '/p',
  relativePath: 'skills/x/SKILL.md',
  plugin: null,
  frontmatter: {},
  detail: {},
  editable: true,
  problem: null,
  conflict: null,
  ...partial,
});

describe('buildMcp', () => {
  it('builds a stdio entry and splits quoted arguments', () => {
    const built = buildMcp({ ...emptyMcpForm, name: 'fs', command: ' npx ', args: '-y server "C:\\My Files"', env: [{ name: 'DEBUG', value: '1', secret: false }] });
    expect(built.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server', 'C:\\My Files'], env: { DEBUG: '1' } });
    expect(built.secrets).toEqual([]);
  });

  it('keeps secret values out of the entry and references them instead', () => {
    const built = buildMcp({
      ...emptyMcpForm,
      name: 'github',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer ghp_abc', secret: true }],
    });
    expect(built.config).toEqual({ type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${GITHUB_AUTHORIZATION}' } });
    expect(built.secrets).toEqual([{ name: 'GITHUB_AUTHORIZATION', value: 'ghp_abc' }]);
    expect(JSON.stringify(built.config)).not.toContain('ghp_abc');
  });

  it('uses the env var name itself as the secret name when it is already valid', () => {
    const built = buildMcp({ ...emptyMcpForm, name: 'pg', command: 'npx', env: [{ name: 'POSTGRES_URL', value: 'postgres://u:p@h/db', secret: true }] });
    expect(built.config.env).toEqual({ POSTGRES_URL: '${POSTGRES_URL}' });
    expect(built.secrets).toEqual([{ name: 'POSTGRES_URL', value: 'postgres://u:p@h/db' }]);
  });

  it('derives valid secret names and splits arguments', () => {
    expect(secretName('my-server.v2', 'X-Api-Key')).toBe('MY_SERVER_V2_X_API_KEY');
    expect(secretName('9lives', 'k')).toBe('_9LIVES_K');
    expect(splitArgs("a 'b c'  d")).toEqual(['a', 'b c', 'd']);
  });

  it('validates the form before anything is written', () => {
    expect(validateMcp({ ...emptyMcpForm, name: 'bad name', command: 'x' })).toContain('Name');
    expect(validateMcp({ ...emptyMcpForm, name: 'ok' })).toContain('command');
    expect(validateMcp({ ...emptyMcpForm, name: 'ok', transport: 'http', url: 'ftp://x' })).toContain('URL');
    expect(validateMcp({ ...emptyMcpForm, name: 'ok', transport: 'http', url: 'https://x', headers: [{ name: 'Authorization', value: 'Bearer ', secret: true }] })).toContain('Authorization');
    expect(validateMcp({ ...emptyMcpForm, name: 'ok', command: 'npx' })).toBeNull();
  });
});

describe('hooks', () => {
  const form = { event: 'PreToolUse', matcher: 'Bash', command: 'guard.sh', timeout: '10' };

  it('adds a hook without changing the original object', () => {
    const existing = { Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }] };
    const next = appendHook(existing, form);
    expect(next.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }] }]);
    expect(next.Stop).toEqual(existing.Stop);
    expect(existing).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }] });
  });

  it('reuses the group with the same matcher and omits an empty matcher and timeout', () => {
    const once = appendHook(undefined, form);
    const twice = appendHook(once, { ...form, command: 'second.sh', timeout: '' });
    expect(twice.PreToolUse).toHaveLength(1);
    expect(twice.PreToolUse?.[0]?.hooks).toEqual([{ type: 'command', command: 'guard.sh', timeout: 10 }, { type: 'command', command: 'second.sh' }]);
    expect(appendHook(null, { event: 'Stop', matcher: ' ', command: 'x', timeout: 'abc' }).Stop).toEqual([{ hooks: [{ type: 'command', command: 'x' }] }]);
  });

  it('removes a handler and drops groups and events left empty', () => {
    const hooks = appendHook(appendHook(undefined, form), { ...form, command: 'second.sh' });
    expect(removeHook(hooks, 'PreToolUse', 0, 0).PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(removeHook(removeHook(hooks, 'PreToolUse', 0, 0), 'PreToolUse', 0, 0)).toEqual({});
    expect(removeHook(hooks, 'Nope', 3, 3)).toEqual(hooks);
  });
});

describe('slash menu', () => {
  const toolkit = [
    item({ name: 'deploy', description: 'Deploys', frontmatter: { 'argument-hint': '[env]' } }),
    item({ name: 'hidden', frontmatter: { 'user-invocable': false } }),
    item({ name: 'old', kind: 'command', scope: 'project', conflict: { wins: false, winnerId: 'w', reason: '', otherIds: [] } }),
    item({ name: 'reviewer', kind: 'agent' }),
  ];

  it('before a session: natives, common built-ins and invocable toolkit items', () => {
    const names = buildMenu(null, toolkit).map((entry) => entry.name);
    expect(names).toContain('model');
    expect(names).toContain('compact');
    expect(names).toContain('deploy');
    expect(names).not.toContain('hidden');
    expect(names).not.toContain('old');
    expect(names).not.toContain('reviewer');
    expect(buildMenu(null, toolkit).find((entry) => entry.name === 'deploy')).toMatchObject({ argumentHint: '[env]', native: null });
  });

  it('during a session: Claude Code\'s list wins, natives keep their CuciCode screen', () => {
    const menu = buildMenu(
      [
        { name: 'model', description: 'terminal picker', argumentHint: '', builtin: true },
        { name: 'deploy', description: 'Deploys', argumentHint: '[env]', builtin: false },
        { name: 'cost', description: 'Cost', argumentHint: '', builtin: true },
      ],
      toolkit,
    );
    expect(menu.find((entry) => entry.name === 'model')?.native).toBe('model');
    expect(menu.find((entry) => entry.name === 'deploy')?.source).toContain('user skill');
    expect(menu.find((entry) => entry.name === 'cost')?.source).toBe('built-in');
    expect(menu.some((entry) => entry.name === 'compact')).toBe(false);
  });

  it('sends commands Claude Code reports as terminal-only to the terminal pane', () => {
    const menu = buildMenu([{ name: 'theme', description: 'Change the theme', argumentHint: '', builtin: true }], toolkit, ['/theme', 'config', 'mcp']);
    expect(menu.find((entry) => entry.name === 'theme')).toMatchObject({ native: 'terminal', description: 'Change the theme' });
    expect(menu.find((entry) => entry.name === 'config')?.native).toBe('terminal');
    expect(menu.find((entry) => entry.name === 'mcp')?.native).toBe('toolkit:mcp');
  });

  it('opens only while the command name is being typed, and ranks prefix matches first', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/com')).toBe('com');
    expect(slashQuery('/compact now')).toBeNull();
    expect(slashQuery('hello /x')).toBeNull();
    const ranked = filterMenu(buildMenu(null, toolkit), 'c').map((entry) => entry.name);
    expect(ranked.slice(0, 3)).toEqual(['clear', 'compact', 'context']);
  });
});

describe('toolkit list', () => {
  const items = [item({ name: 'a', kind: 'agent', scope: 'project' }), item({ name: 'b', description: 'Formats code' }), item({ name: 'c', kind: 'hook', scope: 'local' })];

  it('filters by tab, scope and search text, and counts per kind', () => {
    expect(filterItems(items, 'all', 'all', '').length).toBe(3);
    expect(filterItems(items, 'agent', 'all', '').map((entry) => entry.name)).toEqual(['a']);
    expect(filterItems(items, 'all', 'local', '').map((entry) => entry.name)).toEqual(['c']);
    expect(filterItems(items, 'all', 'all', 'FORMAT').map((entry) => entry.name)).toEqual(['b']);
    expect(countByKind(items)).toEqual({ all: 3, agent: 1, skill: 1, hook: 1 });
  });
});

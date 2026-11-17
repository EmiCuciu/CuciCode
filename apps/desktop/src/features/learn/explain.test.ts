import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@cucicode/protocol';
import { concept, CONCEPTS } from './concepts.ts';
import { explain } from './explain.ts';

const base = { id: 'e', ts: 0, parentToolUseId: null } as const;

describe('explain', () => {
  it('explains each kind of tool call with the right concept', () => {
    const call = (partial: Partial<Extract<TimelineEvent, { kind: 'tool_call' }>>): TimelineEvent => ({ ...base, kind: 'tool_call', category: 'tool', toolUseId: 't', toolName: 'Bash', input: {}, ...partial });
    expect(explain(call({ mcp: { server: 'github', tool: 'create_issue' }, category: 'mcp' }))).toMatchObject({ conceptId: 'mcp' });
    expect(explain(call({ mcp: { server: 'github', tool: 'create_issue' }, category: 'mcp' }))?.text).toContain('"create_issue" on the MCP server "github"');
    expect(explain(call({ category: 'subagent', subagentType: 'Explore' }))?.text).toContain('"Explore" subagent');
    expect(explain(call({ category: 'skill', skillName: 'pdf' }))?.conceptId).toBe('skill');
    expect(explain(call({ toolName: 'Edit' }))?.text).toContain('replaces an exact piece of text');
    expect(explain(call({ toolName: 'SomethingNew' }))?.text).toContain('SomethingNew');
  });

  it('says whether a hook blocked the action', () => {
    const hook = (outcome: 'success' | 'error', exitCode: number): TimelineEvent => ({ ...base, kind: 'hook', category: 'hook', phase: 'finished', hookId: 'h', hookName: 'guard', hookEvent: 'PreToolUse', outcome, exitCode, output: '' });
    expect(explain(hook('error', 2))?.text).toContain('blocks the action');
    expect(explain(hook('error', 1))?.text).toContain('does not block');
    expect(explain(hook('success', 0))?.text).toContain('went ahead');
  });

  it('explains compaction with its numbers and returns nothing for plain messages', () => {
    const compaction: TimelineEvent = { ...base, kind: 'compaction', category: 'compaction', trigger: 'auto', preTokens: 180_000, postTokens: 12_000 };
    expect(explain(compaction)?.text).toContain('180k tokens of history');
    expect(explain(compaction)?.text).toContain('automatically');
    expect(explain({ ...base, kind: 'assistant_text', category: 'message', messageId: 'm', text: 'hi' })).toBeNull();
  });

  it('only links to concepts that exist, and every concept has a docs link', () => {
    const ids = ['mcp', 'subagent', 'skill', 'permissions', 'hook', 'compact-vs-clear', 'settings-scopes', 'context'];
    for (const id of ids) {
      expect(concept(id), id).toBeDefined();
    }
    expect(new Set(CONCEPTS.map((entry) => entry.id)).size).toBe(CONCEPTS.length);
    expect(CONCEPTS.every((entry) => entry.docs.startsWith('https://code.claude.com/docs/'))).toBe(true);
  });
});

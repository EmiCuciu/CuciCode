import { describe, expect, it } from 'vitest';
import { classifyTool, flattenToolResult, MAX_RESULT_CHARS, normalizeMessage } from '../src/normalize.ts';
import { buildAgentEnv } from '../src/env.ts';
import { AsyncQueue } from '../src/asyncQueue.ts';

const live = { source: 'live' as const, now: () => 1000 };
const history = { source: 'history' as const, now: () => null };

describe('classifyTool', () => {
  it('routes subagent, skill, mcp and plain tools to their categories', () => {
    expect(classifyTool('Agent', { subagent_type: 'Explore' })).toEqual({ category: 'subagent', subagentType: 'Explore' });
    expect(classifyTool('Skill', { skill: 'pdf' })).toEqual({ category: 'skill', skillName: 'pdf' });
    expect(classifyTool('mcp__github__create_issue', {})).toEqual({
      category: 'mcp',
      mcp: { server: 'github', tool: 'create_issue' },
    });
    expect(classifyTool('Bash', { command: 'ls' })).toEqual({ category: 'tool' });
  });
});

describe('normalizeMessage', () => {
  it('splits an assistant message into text, thinking and tool call events', () => {
    const events = normalizeMessage(
      {
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } },
          ],
        },
      },
      live,
    );
    expect(events.map((event) => event.kind)).toEqual(['thinking', 'assistant_text', 'tool_call']);
    expect(events.map((event) => event.id)).toEqual(['a1:0', 'a1:1', 'a1:2']);
    expect(events[2]).toMatchObject({ toolUseId: 't1', toolName: 'Read', category: 'tool', ts: 1000 });
  });

  it('emits tool results from live user messages but not the echoed prompt text', () => {
    const message = {
      type: 'user',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'my prompt' },
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: true },
        ],
      },
    };
    const liveEvents = normalizeMessage(message, live);
    expect(liveEvents).toHaveLength(1);
    expect(liveEvents[0]).toMatchObject({ kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: true });
    expect(normalizeMessage(message, history).map((event) => event.kind)).toEqual(['user_message', 'tool_result']);
  });

  it('shows the prompt given to a subagent in live mode', () => {
    const events = normalizeMessage(
      { type: 'user', uuid: 'u2', parent_tool_use_id: 'task1', message: { content: 'explore the repo' } },
      live,
    );
    expect(events[0]).toMatchObject({ kind: 'user_message', parentToolUseId: 'task1', text: 'explore the repo' });
  });

  it('truncates very long tool results and flags it', () => {
    const [event] = normalizeMessage(
      {
        type: 'user',
        uuid: 'u3',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(MAX_RESULT_CHARS + 5) }] },
      },
      live,
    );
    expect(event).toMatchObject({ kind: 'tool_result', truncated: true });
    expect(event?.kind === 'tool_result' && event.content.length).toBe(MAX_RESULT_CHARS);
  });

  it('turns text and thinking stream deltas into stream_delta events and ignores the rest', () => {
    const delta = (inner: unknown) =>
      normalizeMessage({ type: 'stream_event', uuid: 's', parent_tool_use_id: null, event: inner }, live);
    expect(delta({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ab' } })[0]).toMatchObject({
      kind: 'stream_delta',
      deltaType: 'text',
      text: 'ab',
      blockIndex: 1,
    });
    expect(delta({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 't' } })[0]).toMatchObject({
      deltaType: 'thinking',
      category: 'thinking',
    });
    expect(delta({ type: 'message_start' })).toEqual([]);
    expect(delta({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } })).toEqual([]);
  });

  it('maps system subtypes to typed events', () => {
    const system = (fields: Record<string, unknown>) => normalizeMessage({ type: 'system', uuid: 'sys', ...fields }, live)[0];
    expect(system({ subtype: 'init', session_id: 's1', model: 'm', tools: ['Bash'], mcp_servers: [{ name: 'gh', status: 'connected' }] })).toMatchObject({
      kind: 'system_init',
      sessionId: 's1',
      tools: ['Bash'],
      mcpServers: [{ name: 'gh', status: 'connected' }],
    });
    expect(system({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9 } })).toMatchObject({
      kind: 'compaction',
      trigger: 'manual',
      preTokens: 9,
      postTokens: null,
    });
    expect(system({ subtype: 'hook_response', hook_id: 'h', hook_name: 'guard', hook_event: 'PreToolUse', outcome: 'error', exit_code: 2, output: 'no' })).toMatchObject({
      kind: 'hook',
      phase: 'finished',
      outcome: 'error',
      exitCode: 2,
    });
    expect(system({ subtype: 'task_notification', task_id: 'k', status: 'completed', summary: 'done' })).toMatchObject({
      kind: 'subagent',
      phase: 'finished',
      status: 'completed',
    });
    expect(system({ subtype: 'something_new' })).toMatchObject({ kind: 'raw', sdkSubtype: 'something_new' });
  });

  it('summarises result usage per model and rate limit events', () => {
    const [result] = normalizeMessage(
      {
        type: 'result',
        uuid: 'r',
        subtype: 'success',
        is_error: false,
        duration_ms: 5,
        num_turns: 1,
        total_cost_usd: 0.01,
        modelUsage: { sonnet: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.01, contextWindow: 200000 } },
      },
      live,
    );
    expect(result).toMatchObject({ kind: 'result', modelUsage: { sonnet: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 } } });
    const [limit] = normalizeMessage(
      { type: 'rate_limit_event', uuid: 'l', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8, resetsAt: 123 } },
      live,
    );
    expect(limit).toMatchObject({ kind: 'rate_limit', status: 'allowed_warning', window: 'five_hour', utilization: 0.8, resetsAt: 123 });
  });

  it('keeps unknown message types visible as raw events and drops noisy ones', () => {
    expect(normalizeMessage({ type: 'brand_new', uuid: 'n' }, live)[0]).toMatchObject({ kind: 'raw', sdkType: 'brand_new' });
    expect(normalizeMessage({ type: 'tool_progress', uuid: 'p' }, live)).toEqual([]);
    expect(normalizeMessage(null, live)).toEqual([]);
  });
});

describe('flattenToolResult', () => {
  it('joins text blocks and marks non-text blocks', () => {
    expect(flattenToolResult([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a\n[image]');
    expect(flattenToolResult(undefined)).toBe('');
  });
});

describe('buildAgentEnv', () => {
  it('removes credential overrides so the subscription login is used, and keeps the rest', () => {
    const env = buildAgentEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' });
    expect(env.PATH).toBe('p');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^cucicode\//);
  });
});

describe('AsyncQueue', () => {
  it('delivers items pushed before and after a consumer waits, then ends on close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    const pending = iterator.next();
    queue.push(2);
    expect(await pending).toEqual({ value: 2, done: false });
    queue.close();
    expect((await iterator.next()).done).toBe(true);
  });
});

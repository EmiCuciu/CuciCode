import { createContext, useContext, useState, type ReactNode } from 'react';
import type { EventCategory, RewindResult } from '@cucicode/protocol';
import { sidecar } from '../../bridge/tauri.ts';
import { useNav } from '../../state/nav.ts';
import { useApp } from '../../state/store.ts';
import { useLearn } from '../learn/ConceptsView.tsx';
import { concept } from '../learn/concepts.ts';
import { explain } from '../learn/explain.ts';
import { buildRows, hasChildren, type DisplayEvent, type TimelineRow, type TimelineState } from '../../state/timeline.ts';

const CATEGORY_TONE: Record<EventCategory, string> = {
  message: 'text-fg',
  thinking: 'text-muted',
  tool: 'text-accent',
  subagent: 'text-warn',
  skill: 'text-ok',
  mcp: 'text-accent',
  hook: 'text-warn',
  permission: 'text-bad',
  compaction: 'text-muted',
  system: 'text-muted',
  result: 'text-muted',
};

function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return '';
  }
  const fields = input as Record<string, unknown>;
  const preferred = ['command', 'file_path', 'pattern', 'description', 'prompt', 'url', 'query', 'skill'];
  for (const key of preferred) {
    if (typeof fields[key] === 'string') {
      return fields[key];
    }
  }
  return JSON.stringify(input);
}

function Tag({ category, children }: { category: EventCategory; children: ReactNode }) {
  return <span className={`font-mono text-[11px] uppercase tracking-wide ${CATEGORY_TONE[category]}`}>{children}</span>;
}

function Details({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="font-mono text-[11px] text-muted hover:text-fg" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="max-h-80 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap">{children}</pre>;
}

function Line({ category, tag, title, children }: { category: EventCategory; tag: string; title: string; children?: ReactNode }) {
  return (
    <div className="border-l-2 border-line py-1 pl-3">
      <div className="flex items-baseline gap-2">
        <Tag category={category}>{tag}</Tag>
        <span className="min-w-0 truncate font-mono text-[12px]">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** The chat a list of rows belongs to, so a row can act on its own session. */
export const ChatIdContext = createContext<string | null>(null);

function UserMessage({ event }: { event: Extract<DisplayEvent, { kind: 'user_message' }> }) {
  const chatId = useContext(ChatIdContext);
  const open = useApp((state) => (chatId ? state.chats[chatId]?.open === true : false));
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageId = event.id.replace(/:text$/, '');
  const canOffer = chatId !== null && open && event.parentToolUseId === null;

  const rewind = async (dryRun: boolean): Promise<void> => {
    if (chatId === null) {
      return;
    }
    try {
      const result = await sidecar('chat.rewind', { chatId, messageId, dryRun });
      if (!result.canRewind) {
        setPreview(null);
        setMessage(result.error ?? 'Nothing to rewind for this message.');
      } else if (dryRun) {
        setMessage(null);
        setPreview(result);
      } else {
        const count = preview?.filesChanged.length ?? result.filesChanged.length;
        setPreview(null);
        setMessage(`Restored ${count} file(s). The conversation itself was not rewound.`);
      }
    } catch (reason) {
      setPreview(null);
      setMessage(String(reason));
    }
  };

  return (
    <div className="group rounded bg-raised px-3 py-2">
      <div className="whitespace-pre-wrap">
        {event.text}
        {event.attachmentCount > 0 && <span className="ml-2 font-mono text-[11px] text-muted">+{event.attachmentCount} attachment(s)</span>}
      </div>
      {canOffer && preview === null && (
        <button
          type="button"
          className="mt-1 hidden font-mono text-[11px] text-muted hover:text-fg group-hover:block"
          title="Restores files Claude edited after this message. Shell commands and subagent edits are not undone."
          onClick={() => void rewind(true)}
        >
          rewind files to here…
        </button>
      )}
      {preview && (
        <div className="mt-2 rounded border border-warn/60 p-2 text-[12px]">
          <div>
            This restores {preview.filesChanged.length} file(s) to how they were when you sent this message (+{preview.insertions} −{preview.deletions} lines).
          </div>
          <div className="font-mono text-[11px] text-muted">{preview.filesChanged.join(', ')}</div>
          <div className="mt-1 flex gap-3">
            <button type="button" className="text-warn" onClick={() => void rewind(false)}>
              Restore files
            </button>
            <button type="button" className="text-muted" onClick={() => setPreview(null)}>
              cancel
            </button>
          </div>
        </div>
      )}
      {message && <div className="mt-1 text-[11px] text-muted">{message}</div>}
    </div>
  );
}

function PermissionCard({ event, outcome }: { event: Extract<DisplayEvent, { kind: 'permission_request' }>; outcome: string | undefined }) {
  const respond = useApp((state) => state.respondPermission);
  return (
    <div className="rounded border border-bad/50 bg-raised p-3">
      <Tag category="permission">permission</Tag>
      <div className="mt-1">{event.title ?? `Claude wants to use ${event.toolName}`}</div>
      {event.description && <div className="text-muted">{event.description}</div>}
      <Code>{JSON.stringify(event.input, null, 2)}</Code>
      {outcome === undefined ? (
        <div className="mt-2 flex gap-2">
          <button type="button" className="rounded bg-ok/20 px-3 py-1 text-ok hover:bg-ok/30" onClick={() => void respond(event.requestId, 'allow', false)}>
            Allow once
          </button>
          {event.canRemember && (
            <button type="button" className="rounded bg-ok/10 px-3 py-1 text-ok hover:bg-ok/20" onClick={() => void respond(event.requestId, 'allow', true)}>
              Always allow
            </button>
          )}
          <button type="button" className="rounded bg-bad/20 px-3 py-1 text-bad hover:bg-bad/30" onClick={() => void respond(event.requestId, 'deny', false)}>
            Deny
          </button>
        </div>
      ) : (
        <div className="mt-2 font-mono text-[11px] text-muted">{outcome}</div>
      )}
    </div>
  );
}

function ToolCall({ event, timeline, hidden }: { event: Extract<DisplayEvent, { kind: 'tool_call' }>; timeline: TimelineState; hidden: ReadonlySet<EventCategory> }) {
  const result = timeline.results[event.toolUseId];
  const nested = hasChildren(timeline.events, event.toolUseId);
  const tag = event.mcp ? `mcp ${event.mcp.server}` : event.category === 'subagent' ? `agent ${event.subagentType ?? ''}` : event.category;
  const name = event.mcp ? event.mcp.tool : event.skillName ?? event.toolName;
  const state = result === undefined ? '…' : result.isError ? 'error' : 'done';
  return (
    <Line category={event.category} tag={tag} title={`${name}  ${summarizeInput(event.input)}`}>
      <div className="flex flex-col gap-1">
        <Details label={`input · ${state}`}>
          <Code>{JSON.stringify(event.input, null, 2)}</Code>
        </Details>
        {nested && (
          <Details label="thread">
            <div className="ml-2 flex flex-col gap-1">
              <Rows timeline={timeline} parentToolUseId={event.toolUseId} hidden={hidden} />
            </div>
          </Details>
        )}
        {result && (
          <Details label={result.isError ? 'error' : `result${result.truncated ? ' (truncated)' : ''}`}>
            <Code>{result.content}</Code>
          </Details>
        )}
      </div>
    </Line>
  );
}

function renderEvent(event: DisplayEvent, timeline: TimelineState, hidden: ReadonlySet<EventCategory>): ReactNode {
  switch (event.kind) {
    case 'user_message':
      return <UserMessage event={event} />;
    case 'assistant_text':
      return <div className="px-1 py-1 whitespace-pre-wrap">{event.text}</div>;
    case 'thinking':
      return (
        <Line category="thinking" tag="thinking" title={event.text.split('\n')[0] ?? ''}>
          <Details label="full text">
            <div className="text-muted whitespace-pre-wrap">{event.text}</div>
          </Details>
        </Line>
      );
    case 'tool_call':
      return <ToolCall event={event} timeline={timeline} hidden={hidden} />;
    case 'subagent':
      return (
        <Line category="subagent" tag={`subagent ${event.status}`} title={`${event.subagentType ?? 'agent'} · ${event.description}`}>
          {event.usage && (
            <div className="font-mono text-[11px] text-muted">
              {event.usage.totalTokens.toLocaleString()} tokens · {event.usage.toolUses} tool uses · {Math.round(event.usage.durationMs / 1000)}s
            </div>
          )}
          {event.summary && <div className="text-muted">{event.summary}</div>}
        </Line>
      );
    case 'hook':
      return (
        <Line category="hook" tag={`hook ${event.hookEvent}`} title={`${event.hookName} · ${event.outcome ?? 'running'}${event.exitCode !== null ? ` (exit ${event.exitCode})` : ''}`}>
          {event.output && (
            <Details label="output">
              <Code>{event.output}</Code>
            </Details>
          )}
        </Line>
      );
    case 'permission_request':
      return <PermissionCard event={event} outcome={timeline.permissionOutcomes[event.requestId]} />;
    case 'compaction':
      return (
        <Line
          category="compaction"
          tag={`compaction ${event.trigger}`}
          title={`${event.preTokens.toLocaleString()} → ${event.postTokens?.toLocaleString() ?? '?'} tokens`}
        />
      );
    case 'system_init':
      return (
        <Line category="system" tag="session" title={`${event.model} · ${event.permissionMode} · style ${event.outputStyle} · Claude Code ${event.claudeCodeVersion}`}>
          <Details label={`${event.tools.length} tools · ${event.skills.length} skills · ${event.agents.length} agents · ${event.mcpServers.length} MCP servers · ${event.plugins.length} plugins`}>
            <Code>{JSON.stringify({ mcpServers: event.mcpServers, agents: event.agents, skills: event.skills, plugins: event.plugins, tools: event.tools }, null, 2)}</Code>
          </Details>
        </Line>
      );
    case 'result':
      return (
        <Line
          category="result"
          tag={event.isError ? `result ${event.subtype}` : 'turn done'}
          title={`${event.numTurns} turn(s) · ${(event.durationMs / 1000).toFixed(1)}s · ${Object.keys(event.modelUsage).join(', ')}`}
        >
          {event.errors.length > 0 && <Code>{event.errors.join('\n')}</Code>}
        </Line>
      );
    case 'notice':
      return <Line category="system" tag={event.level} title={event.text} />;
    case 'raw':
      return <Line category="system" tag="system" title={`${event.sdkType}${event.sdkSubtype ? `/${event.sdkSubtype}` : ''}`} />;
  }
}

function Explain({ event }: { event: DisplayEvent }) {
  const [open, setOpen] = useState(false);
  const explanation = event.kind === 'user_message' || event.kind === 'assistant_text' ? null : explain(event);
  if (explanation === null) {
    return null;
  }
  const linked = explanation.conceptId ? concept(explanation.conceptId) : undefined;
  return (
    <div className="pl-3">
      <button type="button" className="font-mono text-[11px] text-muted hover:text-accent" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} explain
      </button>
      {open && (
        <div className="mt-1 mb-1 rounded border border-line bg-panel p-2 text-[12px]">
          {explanation.text}
          {linked && (
            <button
              type="button"
              className="ml-2 text-accent hover:underline"
              onClick={() => {
                useLearn.getState().show(linked.id);
                useNav.getState().go('concepts');
              }}
            >
              More: {linked.title} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ row, timeline, hidden }: { row: TimelineRow; timeline: TimelineState; hidden: ReadonlySet<EventCategory> }) {
  return (
    <div className="relative">
      {renderEvent(row.event, timeline, hidden)}
      <Explain event={row.event} />
      {row.repeat > 1 && <span className="absolute top-1 right-1 rounded bg-raised px-1.5 font-mono text-[11px] text-muted">×{row.repeat}</span>}
    </div>
  );
}

export function Rows({ timeline, parentToolUseId, hidden }: { timeline: TimelineState; parentToolUseId: string | null; hidden: ReadonlySet<EventCategory> }) {
  return (
    <>
      {buildRows(timeline.events, parentToolUseId, hidden).map((row) => (
        <Row key={row.event.id} row={row} timeline={timeline} hidden={hidden} />
      ))}
    </>
  );
}

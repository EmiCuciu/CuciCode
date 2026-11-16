export const HOOK_EVENTS: { event: string; matcher: string | null; when: string }[] = [
  { event: 'PreToolUse', matcher: 'tool name, e.g. Bash or Edit|Write', when: 'Before a tool runs. Can block it.' },
  { event: 'PostToolUse', matcher: 'tool name', when: 'After a tool succeeds.' },
  { event: 'PostToolUseFailure', matcher: 'tool name', when: 'After a tool fails.' },
  { event: 'PermissionRequest', matcher: 'tool name', when: 'When Claude Code is about to ask for permission.' },
  { event: 'UserPromptSubmit', matcher: null, when: 'When you send a message, before Claude sees it.' },
  { event: 'Stop', matcher: null, when: 'When Claude finishes responding. Can make it continue.' },
  { event: 'SubagentStart', matcher: 'agent type', when: 'When a subagent starts.' },
  { event: 'SubagentStop', matcher: 'agent type', when: 'When a subagent finishes.' },
  { event: 'SessionStart', matcher: 'startup, resume, clear or compact', when: 'When a session starts or resumes.' },
  { event: 'SessionEnd', matcher: null, when: 'When a session ends.' },
  { event: 'PreCompact', matcher: 'manual or auto', when: 'Before the conversation is compacted.' },
  { event: 'Notification', matcher: 'notification type', when: 'When Claude Code sends a notification.' },
];

export interface HookForm {
  event: string;
  matcher: string;
  command: string;
  timeout: string;
}

type HooksObject = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;

function isGroupList(value: unknown): value is HooksObject[string] {
  return Array.isArray(value);
}

function copyHooks(existing: unknown): HooksObject {
  const source = typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const hooks: HooksObject = {};
  for (const [event, groups] of Object.entries(source)) {
    hooks[event] = isGroupList(groups) ? groups.map((group) => ({ ...group, hooks: [...(group.hooks ?? [])] })) : [];
  }
  return hooks;
}

/**
 * Returns a copy of a scope's `hooks` setting with one command hook added. A group
 * with the same matcher is reused, so related hooks stay together.
 */
export function appendHook(existing: unknown, form: HookForm): HooksObject {
  const hooks = copyHooks(existing);
  const matcher = form.matcher.trim();
  const timeout = Number(form.timeout);
  const handler: Record<string, unknown> = { type: 'command', command: form.command.trim() };
  if (form.timeout.trim().length > 0 && Number.isFinite(timeout) && timeout > 0) {
    handler.timeout = timeout;
  }
  const groups = (hooks[form.event] ??= []);
  const group = groups.find((candidate) => (candidate.matcher ?? '') === matcher);
  if (group) {
    group.hooks.push(handler);
  } else {
    groups.push(matcher.length > 0 ? { matcher, hooks: [handler] } : { hooks: [handler] });
  }
  return hooks;
}

/** Returns a copy without the handler at the given position; empty groups and events are dropped. */
export function removeHook(existing: unknown, event: string, groupIndex: number, handlerIndex: number): HooksObject {
  const hooks = copyHooks(existing);
  const groups = hooks[event] ?? [];
  const group = groups[groupIndex];
  if (group) {
    group.hooks.splice(handlerIndex, 1);
    if (group.hooks.length === 0) {
      groups.splice(groupIndex, 1);
    }
  }
  if (groups.length === 0) {
    delete hooks[event];
  }
  return hooks;
}

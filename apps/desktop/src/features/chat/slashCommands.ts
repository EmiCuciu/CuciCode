import type { CommandOption } from '@cucicode/protocol';
import type { ToolkitItem } from '../../bridge/types.ts';

export type NativeAction = 'model' | 'toolkit:agent' | 'toolkit:mcp' | 'toolkit:hook' | 'toolkit:plugins' | 'newCommand';

export interface SlashEntry {
  name: string;
  description: string;
  argumentHint: string;
  source: string;
  native: NativeAction | null;
}

/** Built-ins that are interactive screens in the terminal and have a CuciCode screen instead. */
const NATIVE: Record<string, { action: NativeAction; description: string }> = {
  model: { action: 'model', description: 'Choose the model and effort (opens the pickers below)' },
  agents: { action: 'toolkit:agent', description: 'Manage agents (opens Toolkit → Agents)' },
  mcp: { action: 'toolkit:mcp', description: 'Manage MCP servers (opens Toolkit → MCP)' },
  hooks: { action: 'toolkit:hook', description: 'Manage hooks (opens Toolkit → Hooks)' },
  plugin: { action: 'toolkit:plugins', description: 'Manage plugins and marketplaces (opens Toolkit → Plugins)' },
};

/** Shown before a session has started, when Claude Code has not reported its command list yet. */
const BEFORE_SESSION: { name: string; description: string }[] = [
  { name: 'clear', description: 'Start over with an empty context' },
  { name: 'compact', description: 'Summarise the conversation to free context' },
  { name: 'context', description: 'Show what is using the context window' },
  { name: 'usage', description: 'Show token usage for this session' },
  { name: 'init', description: 'Create a CLAUDE.md for this project' },
  { name: 'review', description: 'Review the current changes' },
];

function fromToolkit(item: ToolkitItem): SlashEntry {
  const hint = item.frontmatter['argument-hint'];
  return {
    name: item.name,
    description: item.description ?? '',
    argumentHint: typeof hint === 'string' ? hint : '',
    source: `${item.plugin ? `plugin ${item.plugin}` : item.scope} ${item.kind} · ${item.relativePath}`,
    native: null,
  };
}

/**
 * Builds the / menu. Once a session is running, Claude Code's own command list is the
 * source of truth; before that, the menu is assembled from the Toolkit scan.
 */
export function buildMenu(reported: CommandOption[] | null, toolkit: ToolkitItem[]): SlashEntry[] {
  const invocable = toolkit.filter((item) => (item.kind === 'skill' || item.kind === 'command') && item.frontmatter['user-invocable'] !== false && item.conflict?.wins !== false);
  const byName = new Map<string, SlashEntry>();
  const add = (entry: SlashEntry): void => {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  };
  for (const [name, native] of Object.entries(NATIVE)) {
    add({ name, description: native.description, argumentHint: '', source: 'built-in · CuciCode screen', native: native.action });
  }
  if (reported) {
    const sources = new Map(invocable.map((item) => [item.name, fromToolkit(item).source]));
    for (const command of reported) {
      add({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        source: command.builtin ? 'built-in' : (sources.get(command.name) ?? 'custom'),
        native: null,
      });
    }
  } else {
    for (const command of BEFORE_SESSION) {
      add({ ...command, argumentHint: '', source: 'built-in', native: null });
    }
    invocable.map(fromToolkit).forEach(add);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** The text after `/` while the user is still typing the command name, or null when the menu should be closed. */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s]*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

export function filterMenu(entries: SlashEntry[], query: string): SlashEntry[] {
  const needle = query.toLowerCase();
  const starts = entries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  const contains = entries.filter((entry) => !entry.name.toLowerCase().startsWith(needle) && `${entry.name} ${entry.description}`.toLowerCase().includes(needle));
  return [...starts, ...contains];
}

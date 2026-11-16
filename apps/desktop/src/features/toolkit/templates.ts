import type { ItemKind } from '../../bridge/types.ts';

export interface WizardFields {
  name: string;
  description: string;
  model: string;
  tools: string;
  argumentHint: string;
  paths: string;
}

export const emptyFields: WizardFields = { name: '', description: '', model: '', tools: '', argumentHint: '', paths: '' };

export const CREATABLE_KINDS: { kind: ItemKind; label: string; hint: string }[] = [
  { kind: 'agent', label: 'Agent', hint: 'A subagent with its own prompt, tools and model. Claude delegates to it based on the description.' },
  { kind: 'skill', label: 'Skill', hint: 'Instructions Claude loads when relevant, or that you run as /name. A folder, so it can hold scripts.' },
  { kind: 'command', label: 'Command', hint: 'A slash command. Created as a skill, because Claude Code has merged commands into skills.' },
  { kind: 'outputStyle', label: 'Output style', hint: 'Replaces how Claude writes its answers (tone, structure).' },
  { kind: 'rule', label: 'Rule', hint: 'Instructions loaded like CLAUDE.md, optionally only for matching file paths.' },
];

/** Commands are created as skills, so the kind written to disk can differ from the kind chosen. */
export function storedKind(kind: ItemKind): ItemKind {
  return kind === 'command' ? 'skill' : kind;
}

function yamlValue(value: string): string {
  return /^[\w ./,()*-]+$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/^\d/.test(value) ? value : JSON.stringify(value);
}

type Entry = [key: string, value: string, literal?: boolean];

function frontmatter(entries: Entry[]): string {
  const lines = entries
    .filter(([, value]) => value.trim().length > 0)
    .map(([key, value, literal]) => `${key}: ${literal ? value.trim() : yamlValue(value.trim())}`);
  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

export function buildContent(kind: ItemKind, fields: WizardFields): string {
  switch (kind) {
    case 'agent':
      return `${frontmatter([
        ['name', fields.name],
        ['description', fields.description],
        ['tools', fields.tools],
        ['model', fields.model],
      ])}You are ${fields.name}. Describe the agent's job, how it should work, and what it should return.\n`;
    case 'skill':
      return `${frontmatter([
        ['description', fields.description],
        ['argument-hint', fields.argumentHint],
        ['model', fields.model],
      ])}# ${fields.name}\n\nWrite the steps Claude should follow when this skill is used.\n`;
    case 'command':
      return `${frontmatter([
        ['description', fields.description],
        ['argument-hint', fields.argumentHint],
        ['disable-model-invocation', 'true', true],
        ['model', fields.model],
      ])}Write the prompt this command sends. Use $ARGUMENTS for what is typed after /${fields.name}.\n`;
    case 'outputStyle':
      return `${frontmatter([
        ['name', fields.name],
        ['description', fields.description],
      ])}Describe how Claude should write its responses.\n`;
    case 'rule':
      return `${frontmatter([['paths', fields.paths]])}# ${fields.name}\n\nWrite the rules Claude should follow.\n`;
    default:
      return '';
  }
}

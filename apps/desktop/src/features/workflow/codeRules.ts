/** The project rules file CuciCode manages. Claude Code loads it like CLAUDE.md, and the code-rules reviewer checks against it. */
export const RULES_NAME = 'cucicode-code-rules';
export const RULES_RELATIVE = `.claude/rules/${RULES_NAME}.md`;

export const DEFAULT_GUIDANCE = [
  'Do not add code comments; make the code explain itself through names and structure.',
  'Every service class has a Javadoc (or equivalent doc comment) describing its responsibility.',
  'No hardcoded values: URLs, credentials, limits and environment-specific values come from configuration.',
  'Follow the naming and folder structure already used in the project; do not introduce a new convention.',
];

export const ENFORCEMENT = [
  { key: 'secrets', label: 'Block secrets and API keys written into source files' },
  { key: 'envValues', label: 'Block values from .env files copied into code' },
  { key: 'envIgnored', label: 'Block writing a .env file that git would not ignore' },
] as const;
export type EnforcementKey = (typeof ENFORCEMENT)[number]['key'];

const HEADER = '# Code Rules\n\nManaged by CuciCode (Settings → Workflow → Code Rules). Follow these rules in every change.\n\n';

/** The rules are the top-level bullet points of the file; anything else in it is left to the user. */
export function parseGuidance(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => /^\s{0,1}[-*]\s+(.*\S)\s*$/.exec(line)?.[1])
    .filter((rule): rule is string => rule !== undefined);
}

export function renderGuidance(rules: string[]): string {
  const lines = rules.map((rule) => rule.replace(/\s+/g, ' ').trim()).filter((rule) => rule.length > 0);
  return `${HEADER}${lines.map((rule) => `- ${rule}`).join('\n')}\n`;
}

export function rulesPath(projectPath: string): string {
  const separator = projectPath.includes('\\') ? '\\' : '/';
  return [projectPath.replace(/[\\/]+$/, ''), ...RULES_RELATIVE.split('/')].join(separator);
}

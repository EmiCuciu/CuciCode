export type Template = 'empty' | 'node' | 'python' | 'rust' | 'java';
export type RemoteHost = 'none' | 'github' | 'bitbucket';

export interface NewProjectForm {
  name: string;
  parent: string;
  template: Template;
  gitInit: boolean;
  gitignore: boolean;
  remote: RemoteHost;
  remoteOwner: string;
  claudeMd: boolean;
  sharedPlugins: string[];
  codeRules: boolean;
  stories: boolean;
  brainstorm: boolean;
  pipeline: boolean;
  predefinedRouting: boolean;
}

export const TEMPLATES: { id: Template; label: string; note: string }[] = [
  { id: 'empty', label: 'Empty', note: 'No starter code' },
  { id: 'node', label: 'Node.js', note: 'package.json, one module and a node:test test' },
  { id: 'python', label: 'Python', note: 'pyproject.toml, one module and a pytest test' },
  { id: 'rust', label: 'Rust', note: 'Cargo.toml and a main.rs with a test' },
  { id: 'java', label: 'Java', note: 'Maven pom.xml, one service class and a JUnit 5 test' },
];

export function defaultForm(parent: string): NewProjectForm {
  return {
    name: '',
    parent,
    template: 'empty',
    gitInit: true,
    gitignore: true,
    remote: 'none',
    remoteOwner: '',
    claudeMd: true,
    sharedPlugins: [],
    codeRules: true,
    stories: true,
    brainstorm: true,
    pipeline: true,
    predefinedRouting: false,
  };
}

export function validateForm(form: NewProjectForm): string | null {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(form.name) || form.name.endsWith('.')) {
    return 'Name: letters, digits, - _ and . only.';
  }
  if (form.parent.trim().length === 0) {
    return 'Choose where to create the project.';
  }
  if (form.remote !== 'none' && !form.gitInit) {
    return 'A remote repository needs git init.';
  }
  if (form.remote === 'bitbucket' && form.remoteOwner.trim().length === 0) {
    return 'Enter the Bitbucket workspace.';
  }
  return null;
}

export function joinPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`;
}

/** What will happen, in order, shown before anything is created. */
export function summary(form: NewProjectForm): string[] {
  const template = TEMPLATES.find((entry) => entry.id === form.template);
  const lines = [`Create ${joinPath(form.parent, form.name)}`];
  if (form.template !== 'empty') {
    lines.push(`Add ${template?.label} starter files: ${template?.note}`);
  }
  if (form.gitignore) {
    lines.push('Write .gitignore (always .env*, secrets, editor and build output, CuciCode personal files)');
  }
  if (form.claudeMd) {
    lines.push('Write a starter CLAUDE.md (extend it later with /init)');
  }
  if (form.stories) {
    lines.push('Create Stories/ and Plans/');
  }
  lines.push('Set the output style to Concise in .claude/settings.json');
  if (form.codeRules) {
    lines.push('Enable Code Rules: .claude/rules/cucicode-code-rules.md and the enforcement hooks');
  }
  if (form.pipeline) {
    lines.push('Enable the agentic pipeline with checkpoints after plan, stories and review');
  }
  if (form.predefinedRouting) {
    lines.push('Use predefined model routing (planner on Opus, the rest on Sonnet, explorer on Haiku)');
  }
  if (form.gitInit) {
    lines.push('git init on main and commit everything above');
  }
  if (form.remote !== 'none') {
    const host = form.remote === 'github' ? 'GitHub' : 'Bitbucket';
    lines.push(`Create a private ${host} repository${form.remoteOwner ? ` under ${form.remoteOwner}` : ''}, add it as origin and push`);
  }
  if (form.codeRules || form.pipeline) {
    lines.push('Install the CuciCode plugin at user scope if it is missing');
  }
  for (const plugin of form.sharedPlugins) {
    lines.push(`Install ${plugin} for this project`);
  }
  lines.push(form.brainstorm ? 'Open the project with the chat in Brainstorm mode' : 'Open the project');
  return lines;
}

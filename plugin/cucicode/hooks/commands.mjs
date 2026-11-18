import { firstMatch, protectedPatterns, relativeTarget } from './paths.mjs';

const DANGEROUS = [
  ['deletes the root or home directory', /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*(?:\/|~|\$HOME|\*)(?:\s|$)/i],
  ['force-pushes', /\bgit\s+push\b[^;&|]*(?:--force(?!-with-lease)|\s-f\b)/],
  ['discards all local changes', /\bgit\s+reset\s+--hard\b/],
  ['deletes untracked files', /\bgit\s+clean\s+-[a-z]*f/],
  ['skips git hooks', /\bgit\s+(?:commit|push|merge)\b[^;&|]*--no-verify/],
  ['pipes a download into a shell', /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(?:sh|bash|zsh|iex|Invoke-Expression)\b/i],
  ['drops a database', /\bdrop\s+(?:database|schema)\b/i],
  ['formats a disk', /\b(?:mkfs|format-volume|diskpart)\b/i],
];

const WRITE_TARGET =
  /(?:>>?|\btee(?:\s+-a)?|\bsed\s+-i[^\s]*|\bSet-Content|\bOut-File|\bAdd-Content)\s+(?:-\S+\s+)*["']?([^\s"'|;&]+)|\b(?:cp|mv|copy|move|Copy-Item|Move-Item)\s+([^|;&]+)/g;

export function dangerousCommand(command) {
  for (const [name, pattern] of DANGEROUS) {
    if (pattern.test(command)) {
      return name;
    }
  }
  return null;
}

export function protectedWriteTarget(command, projectDir, cwd) {
  const patterns = protectedPatterns(projectDir);
  if (patterns.length === 0) {
    return null;
  }
  for (const match of command.matchAll(WRITE_TARGET)) {
    const targets = match[1] === undefined ? match[2].split(/\s+/).map((token) => token.replace(/^["']|["']$/g, '')) : [match[1]];
    for (const target of targets) {
      const path = target.length === 0 || target.startsWith('-') ? null : relativeTarget(projectDir, cwd, target);
      if (path !== null && firstMatch(patterns, path) !== null) {
        return path;
      }
    }
  }
  return null;
}

export function decideCommand(event, env) {
  const command = event?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) {
    return null;
  }
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const danger = dangerousCommand(command);
  if (danger !== null) {
    return `This command ${danger}. Do not run it; tell the user what you wanted to achieve and let them decide.`;
  }
  const target = protectedWriteTarget(command, projectDir, cwd);
  if (target !== null) {
    return `${target} is a protected path, so the shell may not write to it either. Report it as blocked and let the user act.`;
  }
  return null;
}

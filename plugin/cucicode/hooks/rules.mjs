import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/** Well-known credential formats. Each has a name used in the message shown to the agent. */
const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['a Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an Anthropic or OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['a password or secret assigned in code', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["'`][^"'`\s$%{}<>]{12,}["'`]/i],
];

const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]+>|changeme|change-me|your[-_].*|example.*|placeholder|dummy|test|null|undefined|true|false)$/i;

/** Text a file-changing tool is about to write, from the tool's input. */
export function writtenText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return '';
  }
  const parts = [toolInput.content, toolInput.new_string, toolInput.new_source];
  if (Array.isArray(toolInput.edits)) {
    parts.push(...toolInput.edits.map((edit) => edit?.new_string));
  }
  return parts.filter((part) => typeof part === 'string').join('\n');
}

export function findSecret(text) {
  for (const [name, pattern] of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return name;
    }
  }
  return null;
}

/** Values from `KEY=value` lines, without quotes, comments or placeholders. */
export function parseEnvValues(content) {
  const values = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (value.length >= 8 && !PLACEHOLDER.test(value)) {
      values.push({ key: match[1], value });
    }
  }
  return values;
}

/** `.env`, `.env.local`, `.env.production`, … at the project root, but not templates such as `.env.example`. */
export function envFiles(projectDir) {
  let names = [];
  try {
    names = readdirSync(projectDir);
  } catch {
    return [];
  }
  return names.filter((name) => /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/i.test(name)).map((name) => join(projectDir, name));
}

export function findInlinedEnvValue(text, projectDir) {
  for (const file of envFiles(projectDir)) {
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { key, value } of parseEnvValues(content)) {
      if (text.includes(value)) {
        return { key, file: basename(file) };
      }
    }
  }
  return null;
}

/** True when git would ignore the path. Outside a git repository nothing is ignored. */
function gitIgnores(projectDir, path) {
  const result = spawnSync('git', ['-C', projectDir, 'check-ignore', '-q', '--', path], { encoding: 'utf8' });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Which checks are on. Every check is on unless a settings file turns it off; the personal file wins. */
export function enforcement(projectDir) {
  const enabled = { secrets: true, envValues: true, envIgnored: true };
  for (const name of ['settings.json', 'settings.local.json']) {
    const layer = readJson(join(projectDir, '.claude', 'cucicode', name))?.codeRules?.enforce;
    if (layer && typeof layer === 'object') {
      for (const key of Object.keys(enabled)) {
        if (typeof layer[key] === 'boolean') {
          enabled[key] = layer[key];
        }
      }
    }
  }
  return enabled;
}

function relativeTarget(projectDir, cwd, target) {
  const absolute = isAbsolute(target) ? target : resolve(cwd, target);
  const fromProject = relative(projectDir, absolute).replaceAll('\\', '/');
  return fromProject.startsWith('..') || isAbsolute(fromProject) ? null : fromProject;
}

/**
 * Decides one PreToolUse event for a file-changing tool. Returns null to allow, or the reason
 * to block. `isIgnored` is injectable so tests do not need git.
 */
export function decideRules(event, env, isIgnored = gitIgnores) {
  const input = event?.tool_input;
  const target = input?.file_path ?? input?.notebook_path;
  if (typeof target !== 'string' || target.length === 0) {
    return null;
  }
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const path = relativeTarget(projectDir, cwd, target);
  if (path === null) {
    return null;
  }
  const checks = enforcement(projectDir);
  const isEnvFile = /(^|\/)\.env(\.[^/]+)?$/.test(path) && !/\.(example|sample|template|dist)$/i.test(path);

  if (isEnvFile) {
    if (checks.envIgnored && existsSync(join(projectDir, '.git')) && isIgnored(projectDir, path) === false) {
      return `${path} is not ignored by git, so its values could be committed. Add .env* to .gitignore first. (Code Rules: .env must be in .gitignore)`;
    }
    return null;
  }

  const text = writtenText(input);
  if (text.length === 0) {
    return null;
  }
  if (checks.secrets) {
    const secret = findSecret(text);
    if (secret !== null) {
      return `The change to ${path} contains what looks like ${secret}. Secrets must not be written into source files: read them from configuration or the environment instead. If this is a false positive, tell the user. (Code Rules: no secrets in source)`;
    }
  }
  if (checks.envValues) {
    const inlined = findInlinedEnvValue(text, projectDir);
    if (inlined !== null) {
      return `The change to ${path} contains the value of ${inlined.key} from ${inlined.file}. Read it from the environment instead of copying it into the code. (Code Rules: no env values inlined in code)`;
    }
  }
  return null;
}

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Converts a gitignore-style glob to a regular expression matched against a forward-slash relative path. */
export function globToRegExp(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`, 'i');
}

/** A pattern without a slash matches a file or folder of that name at any depth, as in .gitignore. */
export function matchesGlob(glob, path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const trimmed = glob.trim().replace(/^\//, '');
  if (trimmed.length === 0) {
    return false;
  }
  if (globToRegExp(trimmed).test(normalized)) {
    return true;
  }
  if (!trimmed.includes('/')) {
    const expression = globToRegExp(trimmed);
    return normalized.split('/').some((segment) => expression.test(segment));
  }
  return false;
}

export function firstMatch(patterns, path) {
  return patterns.find((pattern) => matchesGlob(pattern, path)) ?? null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Protected patterns from the project's shared and personal CuciCode settings. */
export function protectedPatterns(projectDir) {
  const patterns = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const list = readJson(join(projectDir, '.claude', 'cucicode', name))?.git?.protectedPaths;
    if (Array.isArray(list)) {
      patterns.push(...list.filter((item) => typeof item === 'string'));
    }
  }
  return patterns;
}

/** "block" (default) refuses writes to protected paths; "ask" lets the user approve each one in the permission prompt. */
export function protectedMode(projectDir) {
  let mode = 'block';
  for (const name of ['settings.json', 'settings.local.json']) {
    const value = readJson(join(projectDir, '.claude', 'cucicode', name))?.git?.protectedPathsMode;
    if (value === 'ask' || value === 'block') {
      mode = value;
    }
  }
  return mode;
}

/** The path a tool wants to change, relative to the project, or null when it is outside the project. */
export function relativeTarget(projectDir, cwd, target) {
  const absolute = isAbsolute(target) ? target : resolve(cwd, target);
  const fromProject = relative(projectDir, absolute).replaceAll('\\', '/');
  return fromProject.startsWith('..') || isAbsolute(fromProject) ? null : fromProject;
}

/** Decides one PreToolUse event: null to allow, or the reason to block. */
export function decide(event, env) {
  const target = event?.tool_input?.file_path ?? event?.tool_input?.notebook_path;
  if (typeof target !== 'string' || target.length === 0) {
    return null;
  }
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const path = relativeTarget(projectDir, cwd, target);
  if (path === null) {
    return null;
  }
  const pattern = firstMatch(protectedPatterns(projectDir), path);
  return pattern === null
    ? null
    : `${path} is a protected path (pattern "${pattern}" in .claude/cucicode/settings.json). Agents may not edit it. Tell the user what change is needed and let them make it or change the protected paths.`;
}

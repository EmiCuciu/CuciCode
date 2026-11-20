import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUOTED_OR_STRUCTURED = /^["'[{|>]/;

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(path);
    }
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

function frontmatterLines(path) {
  const match = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match === null ? [] : match[1].split(/\r?\n/);
}

test('plain frontmatter values contain no colon-space or comment marker that YAML would misread', () => {
  const problems = [];
  for (const path of [...markdownFiles(join(pluginRoot, 'agents')), ...markdownFiles(join(pluginRoot, 'skills'))]) {
    for (const line of frontmatterLines(path)) {
      const separator = line.indexOf(': ');
      const value = separator === -1 ? '' : line.slice(separator + 2).trim();
      if (value !== '' && !QUOTED_OR_STRUCTURED.test(value) && (value.includes(': ') || value.includes(' #'))) {
        problems.push(`${path}: ${line}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

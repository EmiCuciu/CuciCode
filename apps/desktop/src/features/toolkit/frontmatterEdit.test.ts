import { describe, expect, it } from 'vitest';
import { setFrontmatterField } from './frontmatterEdit.ts';

const AGENT = '---\nname: reviewer\ndescription: Reviews diffs\nmodel: sonnet\n---\n\nmodel: this line is body text\n';

describe('setFrontmatterField', () => {
  it('replaces an existing key and leaves the body alone', () => {
    expect(setFrontmatterField(AGENT, 'model', 'opus')).toBe(AGENT.replace('model: sonnet', 'model: opus'));
  });

  it('adds a missing key at the end of the frontmatter', () => {
    expect(setFrontmatterField(AGENT, 'effort', 'high')).toBe(AGENT.replace('model: sonnet\n---', 'model: sonnet\neffort: high\n---'));
  });

  it('removes a key when the value is null, and does nothing when it is absent', () => {
    expect(setFrontmatterField(AGENT, 'model', null)).toBe(AGENT.replace('model: sonnet\n', ''));
    expect(setFrontmatterField(AGENT, 'effort', null)).toBe(AGENT);
  });

  it('keeps Windows line endings', () => {
    const windows = AGENT.replaceAll('\n', '\r\n');
    expect(setFrontmatterField(windows, 'model', 'haiku')).toBe(windows.replace('model: sonnet', 'model: haiku'));
  });

  it('creates frontmatter for a file that has none', () => {
    expect(setFrontmatterField('Just a prompt\n', 'model', 'opus')).toBe('---\nmodel: opus\n---\nJust a prompt\n');
    expect(setFrontmatterField('Just a prompt\n', 'model', null)).toBe('Just a prompt\n');
  });
});

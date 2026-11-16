import { describe, expect, it } from 'vitest';
import { buildContent, emptyFields, storedKind } from './templates.ts';

describe('buildContent', () => {
  it('writes agent frontmatter and omits empty fields', () => {
    const content = buildContent('agent', { ...emptyFields, name: 'reviewer', description: 'Reviews diffs', model: 'sonnet' });
    expect(content.startsWith('---\nname: reviewer\ndescription: Reviews diffs\nmodel: sonnet\n---\n\n')).toBe(true);
    expect(content).not.toContain('tools:');
  });

  it('quotes values that YAML would misread', () => {
    const content = buildContent('agent', { ...emptyFields, name: 'a', description: 'Use when: the user says "go" #now' });
    expect(content).toContain('description: "Use when: the user says \\"go\\" #now"');
    expect(buildContent('skill', { ...emptyFields, name: 's', description: 'true' })).toContain('description: "true"');
    expect(buildContent('skill', { ...emptyFields, name: 's', description: '3 steps' })).toContain('description: "3 steps"');
  });

  it('creates commands as user-invoked skills', () => {
    expect(storedKind('command')).toBe('skill');
    expect(storedKind('agent')).toBe('agent');
    const content = buildContent('command', { ...emptyFields, name: 'ship', description: 'Ship it', argumentHint: '[env]' });
    expect(content).toContain('disable-model-invocation: true\n');
    expect(content).toContain('argument-hint: "[env]"');
    expect(content).toContain('/ship');
  });

  it('writes a rule without frontmatter when no paths are given', () => {
    expect(buildContent('rule', { ...emptyFields, name: 'api' }).startsWith('# api')).toBe(true);
    expect(buildContent('rule', { ...emptyFields, name: 'api', paths: 'src/api/**' }).startsWith('---\npaths: src/api/**\n---')).toBe(true);
  });
});

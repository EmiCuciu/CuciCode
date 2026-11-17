import { describe, expect, it } from 'vitest';
import { defaultForm, joinPath, summary, validateForm } from './newProject.ts';

describe('new project form', () => {
  it('validates the name, the location and the remote options', () => {
    const form = { ...defaultForm('C:\\work'), name: 'shop' };
    expect(validateForm(form)).toBeNull();
    expect(validateForm({ ...form, name: 'my shop' })).toContain('Name');
    expect(validateForm({ ...form, name: 'trailing.' })).toContain('Name');
    expect(validateForm({ ...form, parent: ' ' })).toContain('where');
    expect(validateForm({ ...form, remote: 'github', gitInit: false })).toContain('git init');
    expect(validateForm({ ...form, remote: 'bitbucket' })).toContain('workspace');
    expect(validateForm({ ...form, remote: 'bitbucket', remoteOwner: 'team' })).toBeNull();
  });

  it('joins paths with the separator the parent uses', () => {
    expect(joinPath('C:\\work\\', 'shop')).toBe('C:\\work\\shop');
    expect(joinPath('/home/me', 'shop')).toBe('/home/me/shop');
  });

  it('offers a Java starter', () => {
    expect(summary({ ...defaultForm('/x'), name: 'api', template: 'java' })).toContain('Add Java starter files: Maven pom.xml, one service class and a JUnit 5 test');
  });

  it('summarises every chosen step in order, and only those', () => {
    const lines = summary({ ...defaultForm('/home/me'), name: 'shop', template: 'node', remote: 'github', sharedPlugins: ['fmt@team'] });
    expect(lines[0]).toBe('Create /home/me/shop');
    expect(lines.some((line) => line.includes('Node.js starter files'))).toBe(true);
    expect(lines.indexOf(lines.find((line) => line.startsWith('git init')) ?? '')).toBeLessThan(lines.findIndex((line) => line.includes('GitHub repository')));
    expect(lines).toContain('Install fmt@team for this project');
    expect(lines[lines.length - 1]).toContain('Brainstorm mode');

    const bare = summary({ ...defaultForm('/x'), name: 'a', gitInit: false, gitignore: false, claudeMd: false, stories: false, codeRules: false, pipeline: false, brainstorm: false });
    expect(bare).toEqual(['Create /x/a', 'Set the output style to Concise in .claude/settings.json', 'Open the project']);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
const { Markdown } = await import('./Markdown.tsx');
const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders a pipe table as a real table', () => {
    const out = html('| Feature | Checked |\n|---|---|\n| **Usage** | Rendered |\n| Budget | Unit tests |');
    expect(out).toContain('<table');
    expect(out.match(/<th /g)).toHaveLength(2);
    expect(out.match(/<td /g)).toHaveLength(4);
    expect(out).toContain('<strong>Usage</strong>');
    expect(out).not.toContain('|---|');
  });

  it('renders code blocks, inline code, lists and headings', () => {
    const out = html('## Title\n\n- one\n- two\n\nUse `npm test`.\n\n```ts\nconst x = 1;\n```');
    expect(out).toContain('<h2');
    expect(out.match(/<li>/g)).toHaveLength(2);
    expect(out).toContain('<code');
    expect(out).toContain('const x = 1;');
  });

  it('does not render raw HTML or javascript links', () => {
    const out = html('<script>alert(1)</script>\n\n[click](javascript:alert(1))');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('javascript:');
  });
});

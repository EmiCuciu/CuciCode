import { openUrl } from '@tauri-apps/plugin-opener';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const cell = 'border border-line px-2 py-1 align-top';

const components: Components = {
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-raised">{children}</thead>,
  th: ({ children }) => <th className={`${cell} text-left font-semibold`}>{children}</th>,
  td: ({ children }) => <td className={cell}>{children}</td>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded border border-line bg-bg p-2 font-mono text-[12px] [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  code: ({ children }) => <code className="rounded bg-raised px-1 font-mono text-[12px]">{children}</code>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-accent underline"
      onClick={(event) => {
        event.preventDefault();
        if (href) {
          void openUrl(href).catch(() => undefined);
        }
      }}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>,
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-[14px] font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 font-semibold">{children}</h3>,
  hr: () => <hr className="my-3 border-line" />,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
};

/** Assistant text as formatted markdown, including GitHub-style tables. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="px-1 py-1 break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

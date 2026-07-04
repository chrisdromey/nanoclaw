import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownViewProps {
  markdown: string;
}

/**
 * Dark-theme markdown renderer (react-markdown + GFM). Used for target
 * knowledge-base documents — those rely on GFM tables, so tables must render
 * as real <table> elements. No dangerouslySetInnerHTML anywhere: react-markdown
 * builds a React element tree from the AST.
 */
const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-section-title text-zinc-200 mt-6 mb-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-section-title text-zinc-200 mt-6 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-heading text-zinc-200 mt-5 mb-2 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-heading text-zinc-300 mt-4 mb-1.5 first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-heading text-zinc-300 mt-3 mb-1 first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-heading text-zinc-400 mt-3 mb-1 first:mt-0">{children}</h6>
  ),
  p: ({ children }) => (
    <p className="text-zinc-400 text-sm leading-relaxed mb-3">{children}</p>
  ),
  strong: ({ children }) => <strong className="text-zinc-200 font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 space-y-1 text-zinc-400 text-sm leading-relaxed mb-3">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 space-y-1 text-zinc-400 text-sm leading-relaxed mb-3">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => (
    <tbody className="divide-y divide-zinc-800">{children}</tbody>
  ),
  tr: ({ children }) => <tr className="border-b border-zinc-800">{children}</tr>,
  th: ({ children }) => (
    <th className="text-left text-zinc-500 font-medium px-2 py-1.5 border-b border-zinc-800">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="text-zinc-400 px-2 py-1.5 align-top">{children}</td>
  ),
  code: ({ children }) => (
    <code className="bg-raised px-1 rounded font-mono text-xs text-zinc-300">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="bg-raised rounded-md p-3 overflow-x-auto font-mono text-xs text-zinc-300 mb-3">
      {children}
    </pre>
  ),
  hr: () => <hr className="border-zinc-800 my-4" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-700 pl-3 italic text-zinc-500 mb-3">
      {children}
    </blockquote>
  ),
};

export default function MarkdownView({ markdown }: MarkdownViewProps) {
  return (
    <div className="max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

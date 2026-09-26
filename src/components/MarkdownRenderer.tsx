"use client";
import remarkGfm from "remark-gfm";

import dynamic from "next/dynamic";
import { downloadCodeBlock } from "@/lib/file-adapter";
import { IconCopy, IconDownload, IconImage } from "./Icons";
import { useState, useEffect } from "react";

// Lazy-load react-markdown — removes ~80KB from main bundle
const ReactMarkdown = dynamic(
  () => import("react-markdown"),
  { ssr: false, loading: () => <p className="md-paragraph">Loading…</p> }
);

// Lazy-load the meter strip — only agents' transcript summaries use it.
const PromptMeterStrip = dynamic(() => import("./PromptMeterStrip"), { ssr: false });

// The worker appends the per-task meter summary as its own paragraph; detect
// it and render the designed strip instead of plain italic text.
const METER_LINE_PREFIX = "Prompt meter:";

// Lazy-load syntax highlighter — removes ~70KB from main bundle
const SyntaxHighlighter = dynamic(
  () => import("react-syntax-highlighter").then(mod => mod.Prism),
  { ssr: false, loading: () => <pre className="code-block-pre">Loading…</pre> }
);

// Lazy-load the prism theme only when a code block actually renders
function SyntaxHighlighterWithTheme({ language, children, ...props }: { language: string; children: string; [key: string]: any }) {
  const [theme, setTheme] = useState<any>(null);

  useEffect(() => {
    import("react-syntax-highlighter/dist/esm/styles/prism").then(m => setTheme(m.oneLight));
  }, []);

  if (!theme) return <pre className="code-block-pre">{children}</pre>;

  return (
    <SyntaxHighlighter style={theme} language={language} PreTag="div" {...props}>
      {children}
    </SyntaxHighlighter>
  );
}

interface Props {
  content: string;
}

/** Flatten a react-markdown children tree to plain text (for detection). */
function flattenText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return flattenText(props?.children);
  }
  return "";
}

function getFileExt(lang: string): string {
  const map: Record<string, string> = {
    javascript: "js", typescript: "ts", jsx: "jsx", tsx: "tsx",
    python: "py", ruby: "rb", go: "go", rust: "rs", java: "java",
    c: "c", cpp: "cpp", csharp: "cs", php: "php", swift: "swift",
    html: "html", css: "css", scss: "scss", sql: "sql",
    bash: "sh", shell: "sh", sh: "sh", zsh: "sh",
    json: "json", yaml: "yaml", yml: "yml", toml: "toml",
    xml: "xml", markdown: "md", md: "md", graphql: "graphql",
    prisma: "prisma", dockerfile: "dockerfile", makefile: "makefile",
    dart: "dart", kotlin: "kt", scala: "scala",
    haskell: "hs", elixir: "ex", erlang: "erl", clojure: "clj",
    vim: "vim", nginx: "conf", apache: "conf",
  };
  return map[lang.toLowerCase()] || lang.toLowerCase();
}

export default function MarkdownRenderer({ content }: Props) {
  // Sanitize HTML br tags — convert to markdown line breaks (two spaces + newline)
  const sanitized = content
    .replace(/<br\s*\/?>/gi, "  \n")
    .replace(/<\/br\s*>/gi, "");

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const codeStr = String(children).replace(/\n$/, "");
          if (match) {
            const lang = match[1];
            const ext = getFileExt(lang);
            return (
              <div className="code-block">
                <div className="code-block-header">
                  <span className="code-block-lang">{lang}</span>
                  <div className="code-block-actions">
                    <button
                      onClick={() => navigator.clipboard.writeText(codeStr)}
                      className="code-block-btn"
                      title="Copy to clipboard"
                    >
                      <IconCopy size={12} /> Copy
                    </button>
                    <button
                      onClick={() => downloadCodeBlock(codeStr, lang)}
                      className="code-block-btn"
                      title={`Download as .${ext}`}
                    >
                      <IconDownload size={12} /> Save
                    </button>
                  </div>
                </div>
                <SyntaxHighlighterWithTheme
                  language={match[1]}
                  customStyle={{ margin: 0, fontSize: "13px", background: "#fafafa" }}
                >
                  {codeStr}
                </SyntaxHighlighterWithTheme>
              </div>
            );
          }
          return (
            <code className="inline-code" {...props}>
              {children}
            </code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        p({ children }) {
          // Prompt-meter summary line → designed strip (see PromptMeterStrip).
          // Wrapped: a cosmetic detection must NEVER break message rendering
          // (a stale HMR chunk here once crashed every chat page).
          try {
            const text = flattenText(children);
            if (text.trim().startsWith(METER_LINE_PREFIX)) {
              return <PromptMeterStrip line={text} />;
            }
          } catch {
            /* fall through to the plain paragraph */
          }
          return <p className="md-paragraph">{children}</p>;
        },
        ul({ children }) {
          return <ul className="md-list">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="md-list md-list-ordered">{children}</ol>;
        },
        h1({ children }) {
          return <h1 className="md-h1">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="md-h2">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="md-h3">{children}</h3>;
        },
        a({ href, children }) {
          return <a href={href} className="md-link" target="_blank" rel="noopener noreferrer">{children}</a>;
        },
        blockquote({ children }) {
          return <blockquote className="md-blockquote">{children}</blockquote>;
        },
        table({ children }) {
          return <div className="md-table-wrap"><table className="md-table">{children}</table></div>;
        },
        th({ children }) {
          return <th className="md-th">{children}</th>;
        },
        td({ children }) {
          return <td className="md-td">{children}</td>;
        },
        br() {
          return <br />;
        },
        img({ src, alt }) {
          // Markdown like `![]()` produces src="" — rendering it would make the
          // browser re-fetch the whole page (and trip the Next.js dev warning).
          if (!src) return null;
          return (
            <div className="md-image-wrap">
              <img src={src} alt={alt || ""} className="md-image" loading="lazy" />
              <div className="md-image-actions">
                <button
                  onClick={() => { const a = document.createElement("a"); a.href = src || ""; a.download = alt || "image.png"; a.click(); }}
                  className="code-block-btn"
                >
                  <IconDownload size={12} /> Save Image
                </button>
                <button
                  onClick={() => { const a = document.createElement("a"); a.href = src || ""; a.target = "_blank"; a.click(); }}
                  className="code-block-btn"
                >
                  <IconImage size={12} /> Open
                </button>
              </div>
            </div>
          );
        },
      }}
    >
      {sanitized}
    </ReactMarkdown>
  );
}

export { downloadCodeBlock as downloadFile };

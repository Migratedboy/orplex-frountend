"use client";
import remarkGfm from "remark-gfm";

import dynamic from "next/dynamic";
import { downloadCodeBlock } from "@/lib/file-adapter";
import { IconCopy, IconDownload, IconImage } from "./Icons";
import { useState, useEffect, useMemo } from "react";
import type { Components } from "react-markdown";

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

// Lazy-load syntax highlighter — PrismLight + explicit languages (~70% smaller than full Prism).
// NOTE: the Light build MUST be prism-light (refractor core), not light
// (lowlight/hljs core) — prism grammars + prism themes only apply there.
const SyntaxHighlighter = dynamic(
  () => import("react-syntax-highlighter/dist/esm/prism-light").then(async (mod) => {
    const { default: Light } = mod as unknown as { default: React.ComponentType<Record<string, unknown>> };
    const reg = (Light as unknown as { registerLanguage: (n: string, l: unknown) => void }).registerLanguage;
    const alias = (Light as unknown as { alias?: (n: string, a: string[]) => void }).alias;
    const [{ default: js }, { default: ts }, { default: python }, { default: bash }, { default: json }, { default: jsx }, { default: tsx }] = await Promise.all([
      import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/python"),
      import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
      import("react-syntax-highlighter/dist/esm/languages/prism/json"),
      import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
      import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
    ]);
    reg("javascript", js);
    reg("typescript", ts);
    reg("python", python);
    reg("bash", bash);
    reg("json", json);
    reg("jsx", jsx);
    reg("tsx", tsx);
    // Common fence aliases so ```sh/```shell/```yml etc. highlight instead of going plain.
    try {
      alias?.("bash", ["sh", "shell", "zsh"]);
      alias?.("javascript", ["js", "jsx"]);
      alias?.("typescript", ["ts", "tsx"]);
      alias?.("json", ["jsonc"]);
      alias?.("python", ["py"]);
    } catch {}
    return Light;
  }),
  { ssr: false, loading: () => <pre className="code-block-pre">Loading…</pre> }
);

// Lazy-load the prism theme only when a code block actually renders
function SyntaxHighlighterWithTheme({ language, children, ...props }: { language: string; children: string; [key: string]: any }) {
  const [theme, setTheme] = useState<any>(null);

  useEffect(() => {
    let live = true;
    import("react-syntax-highlighter/dist/esm/styles/prism").then(m => { if (live) setTheme(m.oneLight); });
    return () => { live = false; };
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

/**
 * react-markdown component overrides, hoisted to module scope.
 *
 * They were an inline object literal in JSX, so a new object with 30+ closures
 * was built on EVERY render. react-markdown compares the `components` prop by
 * identity, so a fresh object invalidated its internal memo and forced a full
 * remark re-parse of the document on every frame - 8x/second while streaming.
 * None of these closures capture props or state, so hoisting is safe.
 */
const MD_COMPONENTS: Components = {
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
        hr() {
          // Thematic break → app hairline; the UA default is a heavy 3D rule.
          return <hr className="md-hr" />;
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
          // Only allow safe URL schemes — javascript:, data:, vbscript: in a
          // link would execute in the app's origin on click.
          const raw = (href || "").trim();
          // Strip control chars / encoded newlines attackers use to smuggle schemes.
          const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/%0[aAdD]/g, "");
          const safe = /^(https?:|mailto:)/i.test(cleaned);
          if (!safe) return <span className="md-link">{children}</span>;
          return <a href={cleaned} className="md-link" target="_blank" rel="noopener noreferrer">{children}</a>;
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
          // Raster data-URLs only: data:image/svg+xml executes script when
          // opened as a document, so SVG is never allowlisted here.
          if (!src || !/^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(src.trim())) return null;
          return (
            <div className="md-image-wrap">
              <img src={src} alt={alt || ""} className="md-image" loading="lazy" referrerPolicy="no-referrer" />
              <div className="md-image-actions">
                <button
                  onClick={() => { const a = document.createElement("a"); a.href = src || ""; a.download = alt || "image.png"; a.click(); }}
                  className="code-block-btn"
                >
                  <IconDownload size={12} /> Save Image
                </button>
                <button
                  onClick={() => {
                    // Never target=_blank a data: URL — SVG inside would run script
                    // in the opener's context. Download instead; open only http(s).
                    if (/^https?:/i.test(src || "")) window.open(src, "_blank", "noopener,noreferrer");
                    else { const a = document.createElement("a"); a.href = src || ""; a.download = alt || "image.png"; a.click(); }
                  }}
                  className="code-block-btn"
                >
                  <IconImage size={12} /> Open
                </button>
              </div>
            </div>
          );
        },
      };

export default function MarkdownRenderer({ content }: Props) {
  // Sanitize HTML br tags — convert to markdown line breaks (two spaces + newline)
  // Two regex passes over the whole message, previously on every render.
  const sanitized = useMemo(
    () =>
      content.replace(/<br\s*\/?>/gi, "  \n").replace(/<\/br\s*>/gi, ""),
    [content]
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={MD_COMPONENTS}
    >
      {sanitized}
    </ReactMarkdown>
  );
}

export { downloadCodeBlock as downloadFile };

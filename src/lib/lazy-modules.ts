// lazy-modules.ts — Lazy-load heavy modules to reduce initial bundle size
//
// These modules are only needed when specific features are used.
// Lazy-loading them keeps the initial page load fast.

/**
 * Lazy-load tree-sitter (only needed for code parsing).
 * Caches the module after first load.
 */
let _treeSitter: any = null;
let _treeSitterLoading: Promise<any> | null = null;

export async function getTreeSitter() {
  if (_treeSitter) return _treeSitter;
  if (_treeSitterLoading) return _treeSitterLoading;

  _treeSitterLoading = import("tree-sitter").then(async (ts) => {
    const Parser = ts.default;
    const parser = new Parser();

    try {
      const TypeScript = await import("tree-sitter-typescript");
      parser.setLanguage(TypeScript.typescript);
    } catch {
      // Fallback: tree-sitter without language support
      console.warn("[lazy-modules] tree-sitter-typescript not available");
    }

    _treeSitter = parser;
    return _treeSitter;
  });

  return _treeSitterLoading;
}

/**
 * Lazy-load Monaco editor (only needed for code editing).
 */
let _monaco: any = null;

export async function getMonaco() {
  if (_monaco) return _monaco;

  try {
    const monacoModule = await import("@monaco-editor/react");
    _monaco = monacoModule;
    return _monaco;
  } catch {
    console.warn("[lazy-modules] @monaco-editor/react not available");
    return null;
  }
}

/**
 * Lazy-load react-syntax-highlighter (only needed for code blocks).
 */
let _syntaxHighlighter: any = null;

export async function getSyntaxHighlighter() {
  if (_syntaxHighlighter) return _syntaxHighlighter;

  const syntaxModule = await import("react-syntax-highlighter");
  _syntaxHighlighter = syntaxModule;
  return _syntaxHighlighter;
}

/**
 * Lazy-load JSZip (only needed for workspace export).
 */
let _jszip: any = null;

export async function getJSZip() {
  if (_jszip) return _jszip;

  const jszipModule = await import("jszip");
  _jszip = jszipModule.default;
  return _jszip;
}

/**
 * Lazy-load Zod (only needed for runtime validation).
 */
let _zod: any = null;

export async function getZod() {
  if (_zod) return _zod;

  const zodModule = await import("zod");
  _zod = zodModule;
  return _zod;
}

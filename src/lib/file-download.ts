// file-download.ts — Download utilities for UI
// Separated from file processing (file-utils.ts)

export function downloadFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadAsMarkdown(content: string): void {
  downloadFile(content, "orplex-response.md");
}

export function downloadCodeBlock(code: string, lang: string): void {
  const extMap: Record<string, string> = {
    javascript: "js", typescript: "ts", python: "py", ruby: "rb",
    go: "go", rust: "rs", java: "java", c: "c", cpp: "cpp",
    html: "html", css: "css", sql: "sql", bash: "sh", shell: "sh",
    json: "json", yaml: "yaml", markdown: "md", prisma: "prisma",
    graphql: "graphql", php: "php", swift: "swift", dart: "dart",
    kotlin: "kt", scala: "scala", lua: "lua", r: "r",
  };
  const ext = extMap[lang.toLowerCase()] || lang.toLowerCase();
  downloadFile(code, `code.${ext}`);
}

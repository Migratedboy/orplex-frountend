// file-utils.ts — File type detection, reading, and formatting
// Pure utility functions with no download/UI concerns

// === CONSTANTS ===

export const TEXT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".scss", ".html", ".md",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs",
  ".sql", ".sh", ".bash", ".yaml", ".yml", ".toml", ".env", ".gitignore",
  ".txt", ".csv", ".xml", ".svg", ".vue", ".svelte", ".prisma", ".graphql",
  ".php", ".kt", ".swift", ".dart", ".lua", ".r", ".zig", ".nim",
];

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

export const MAX_TEXT_SIZE = 500 * 1024; // 500KB
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// === TYPE DETECTION ===

export function getExt(filename: string): string {
  return "." + filename.split(".").pop()?.toLowerCase();
}

export function isTextFile(filename: string): boolean {
  const ext = getExt(filename);
  return TEXT_EXTENSIONS.includes(ext) || filename.startsWith(".");
}

export function isImageFile(filename: string): boolean {
  const ext = getExt(filename);
  return IMAGE_EXTENSIONS.includes(ext);
}

// === FILE READING ===

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

// === FORMATTING ===

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

const FILE_ICONS: Record<string, string> = {
  ts: "TS", tsx: "TSX", js: "JS", jsx: "JSX", json: "JSON",
  py: "PY", rb: "RB", go: "GO", rs: "RS", java: "JV",
  html: "HTML", css: "CSS", md: "MD", sql: "SQL",
  sh: "SH", yaml: "YML", yml: "YML", toml: "TOML",
  prisma: "PRM", graphql: "GQL",
  png: "IMG", jpg: "IMG", jpeg: "IMG", gif: "IMG", webp: "IMG",
};

export function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || ext.toUpperCase() || "FILE";
}

// === BATCH PROCESSING ===

export interface ProcessedFile {
  name: string;
  content: string;
  size: number;
  type: "text" | "image";
  dataUrl?: string;
}

export async function processFileList(fileList: FileList): Promise<ProcessedFile[]> {
  const files: ProcessedFile[] = [];

  for (const file of Array.from(fileList)) {
    if (isImageFile(file.name)) {
      if (file.size > MAX_IMAGE_SIZE) continue;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        files.push({ name: file.name, content: "", size: file.size, type: "image", dataUrl });
      } catch {}
      continue;
    }

    if (isTextFile(file.name) || file.type.startsWith("text/")) {
      if (file.size > MAX_TEXT_SIZE) continue;
      try {
        const content = await readFileAsText(file);
        files.push({ name: file.name, content, size: file.size, type: "text" });
      } catch {}
      continue;
    }

    if (file.size > MAX_TEXT_SIZE) continue;
    try {
      const content = await readFileAsText(file);
      files.push({ name: file.name, content, size: file.size, type: "text" });
    } catch {}
  }

  return files;
}

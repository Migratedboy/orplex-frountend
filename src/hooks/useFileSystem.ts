"use client";

import { useState, useCallback, useRef } from "react";
import { useToast } from "@/components/Toast";

import { apiFetch } from "@/lib/api-base";
export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
}

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "json", "css", "html", "md", "txt", "yaml", "yml",
  "toml", "prisma", "sql", "sh", "env", "gitignore", "prettierrc", "eslintrc",
  "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "h", "rb", "php",
  "swift", "kt", "dart", "vue", "svelte", "astro", "mdx", "graphql", "gql",
]);

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return TEXT_EXTENSIONS.has(ext);
}

export function useFileSystem() {
  const { toast } = useToast();
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});

  // Keep handles mapped by path for fast writes
  const fileHandlesRef = useRef<Map<string, FileSystemFileHandle>>(new Map());

  // Recursively scans a directory handle and constructs the tree
  const scanDirectory = useCallback(async (
    dirHandle: FileSystemDirectoryHandle,
    basePath = ""
  ): Promise<FileNode[]> => {
    const nodes: FileNode[] = [];
    const ignoreList = [
      ".git", "node_modules", ".next", "dist", ".freebuff",
      "package-lock.json", "tsconfig.tsbuildinfo", ".env", "dev.db",
      "yarn.lock", "pnpm-lock.yaml", ".cache", "out", "build",
    ];

    for await (const entry of (dirHandle as any).values()) {
      if (ignoreList.includes(entry.name)) continue;

      const path = basePath ? `${basePath}/${entry.name}` : entry.name;

      if (entry.kind === "file") {
        fileHandlesRef.current.set(path, entry);
        nodes.push({ name: entry.name, path, kind: "file", handle: entry });
      } else if (entry.kind === "directory") {
        const children = await scanDirectory(entry, path);
        nodes.push({
          name: entry.name, path, kind: "directory",
          children: children.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
          handle: entry,
        });
      }
    }
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, []);

  /**
   * Bulk-read all text files in the tree into the fileContents cache.
   * Called automatically after a folder is opened so the AI context is
   * immediately populated without requiring the user to click files.
   */
  const readAllFiles = useCallback(async (nodes: FileNode[]): Promise<void> => {
    const MAX_FILE_SIZE = 150 * 1024; // 150 KB limit per file
    const MAX_TOTAL_FILES = 120;
    let count = 0;

    const readNode = async (node: FileNode): Promise<void> => {
      if (count >= MAX_TOTAL_FILES) return;

      if (node.kind === "file" && isTextFile(node.name)) {
        const handle = fileHandlesRef.current.get(node.path);
        if (handle) {
          try {
            const file = await handle.getFile();
            if (file.size < MAX_FILE_SIZE) {
              const text = await file.text();
              setFileContents(prev => ({ ...prev, [node.path]: text }));
              count++;
            }
          } catch {
            // silently skip unreadable files
          }
        }
      } else if (node.kind === "directory" && node.children) {
        for (const child of node.children) {
          await readNode(child);
        }
      }
    };

    for (const node of nodes) {
      await readNode(node);
    }
  }, []);

  const openFolder = useCallback(async () => {
    try {
      if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
        toast("File System Access API is not supported in this browser. Please use Chrome or Edge.", "error");
        return;
      }

      const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });

      fileHandlesRef.current.clear();
      setFileContents({});

      const tree = await scanDirectory(handle);
      setDirectoryHandle(handle);
      setDirectoryName(handle.name);
      setFileTree(tree);

      toast(`Mapped "${handle.name}" — indexing files for AI context…`, "success");

      // Auto-bulk-read all text files so AI can see them immediately
      await readAllFiles(tree);

      const fileCount = fileHandlesRef.current.size;
      toast(`Indexed ${fileCount} files in "${handle.name}". AI can now read your workspace!`, "success");

      // Register the ABSOLUTE path server-side so agent terminal commands
      // (npm install, node server.js, …) run in THIS folder. The File System
      // Access API never exposes paths, so derive it from an indexed file via
      // Electron's webUtils.getPathForFile (empty outside Electron — the
      // server then falls back to its own cwd).
      try {
        let absPath = "";
        for (const fileHandle of fileHandlesRef.current.values()) {
          const f = await fileHandle.getFile();
          const p = await (window as any).orplexDesktop?.getPathForFile?.(f);
          if (p) {
            absPath = p.replace(/[\\/][^\\/]+$/, ""); // strip filename → directory
            break;
          }
        }
        if (absPath) {
          const res = await apiFetch("/api/agent/workspace-cwd", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: absPath }),
          });
          if (res.ok) toast(`Terminal commands will run in "${absPath}"`, "success");
        }
      } catch {}
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error(err);
        toast(`Error opening folder: ${err.message}`, "error");
      }
    }
  }, [scanDirectory, readAllFiles, toast]);

  const readFile = useCallback(async (path: string): Promise<string> => {
    try {
      // Return from cache if already read
      const cached = fileContents[path];
      if (cached !== undefined) return cached;

      const handle = fileHandlesRef.current.get(path);
      if (!handle) return `[Error: file not found at path "${path}"]`;

      const file = await handle.getFile();
      const text = await file.text();
      setFileContents(prev => ({ ...prev, [path]: text }));
      return text;
    } catch (err: any) {
      toast(`Error reading file ${path}: ${err.message || err}`, "error");
      return `[Error reading file: ${err.message || err}]`;
    }
  }, [toast, fileContents]);

  const writeFile = useCallback(async (path: string, content: string): Promise<boolean> => {
    let handle = fileHandlesRef.current.get(path);

    try {
      if (!handle && directoryHandle) {
        const parts = path.split("/");
        const fileName = parts.pop()!;
        let currentDir = directoryHandle;

        for (const part of parts) {
          currentDir = await currentDir.getDirectoryHandle(part, { create: true });
        }

        handle = await currentDir.getFileHandle(fileName, { create: true });
        fileHandlesRef.current.set(path, handle);

        const tree = await scanDirectory(directoryHandle);
        setFileTree(tree);
      }

      if (!handle) throw new Error("No file handle found. Open a folder first.");

      const writable = await (handle as any).createWritable();
      await writable.write(content);
      await writable.close();

      setFileContents(prev => ({ ...prev, [path]: content }));
      return true;
    } catch (err: any) {
      console.error(err);
      toast(`Error writing file ${path}: ${err.message}`, "error");
      return false;
    }
  }, [directoryHandle, scanDirectory, toast]);

  const editFile = useCallback(async (filePath: string, oldText: string, newText: string): Promise<boolean> => {
    try {
      let handle = fileHandlesRef.current.get(filePath);
      if (!handle) {
        // Try reading from cache
        const cached = fileContents[filePath];
        if (!cached) return false;
      }

      // Read current content
      let content = "";
      if (handle) {
        const file = await handle.getFile();
        content = await file.text();
      } else {
        content = fileContents[filePath] || "";
      }

      if (!content.includes(oldText)) {
        toast(`Text not found in ${filePath}`, "error");
        return false;
      }

      // Replace and write back
      content = content.replace(oldText, newText);

      // Get or create handle
      if (!handle && directoryHandle) {
        const parts = filePath.split("/");
        const fileName = parts.pop()!;
        let currentDir = directoryHandle;
        for (const part of parts) {
          currentDir = await currentDir.getDirectoryHandle(part, { create: true });
        }
        handle = await currentDir.getFileHandle(fileName, { create: true });
        fileHandlesRef.current.set(filePath, handle);
      }

      if (!handle) throw new Error("No file handle");

      const writable = await (handle as any).createWritable();
      await writable.write(content);
      await writable.close();

      setFileContents(prev => ({ ...prev, [filePath]: content }));
      return true;
    } catch (err: any) {
      console.error(err);
      toast(`Error editing ${filePath}: ${err.message}`, "error");
      return false;
    }
  }, [fileContents, directoryHandle, toast]);

  return {
    directoryHandle,
    directoryName,
    fileTree,
    activeFilePath,
    setActiveFilePath,
    fileContents,
    openFolder,
    readFile,
    readAllFiles,
    writeFile,
    editFile,
  };
}

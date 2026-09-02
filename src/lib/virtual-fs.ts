// virtual-fs.ts — In-memory virtual filesystem
// Stores files created by the AI when no local folder is open.
// Syncs with the real File System Access API when a folder IS open.

type Listener = () => void;

interface VirtualFile {
  path: string;
  content: string;
  createdAt: number;
}

class VirtualFileSystem {
  private files = new Map<string, VirtualFile>();
  private listeners = new Set<Listener>();

  /** Write or overwrite a file */
  writeFile(path: string, content: string): boolean {
    this.files.set(path, {
      path,
      content,
      createdAt: Date.now(),
    });
    this.notify();
    return true;
  }

  /** Read a file's content */
  readFile(path: string): string | null {
    return this.files.get(path)?.content ?? null;
  }

  /** Check if a file exists */
  exists(path: string): boolean {
    return this.files.has(path);
  }

  /** Delete a file */
  deleteFile(path: string): boolean {
    const deleted = this.files.delete(path);
    if (deleted) this.notify();
    return deleted;
  }

  /** Get all files as a flat map */
  getAllFiles(): Map<string, VirtualFile> {
    return new Map(this.files);
  }

  /** Get file count */
  getFileCount(): number {
    return this.files.size;
  }

  /** Build a tree structure for the sidebar */
  getTree(): VirtualFileNode[] {
    const root: VirtualFileNode[] = [];
    const sorted = Array.from(this.files.values()).sort((a, b) => a.path.localeCompare(b.path));

    for (const file of sorted) {
      const parts = file.path.split("/").filter(Boolean);
      let current = root;

      // Build directory nodes
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        let existing = current.find(n => n.name === dirName && n.kind === "directory");
        if (!existing) {
          existing = { name: dirName, path: parts.slice(0, i + 1).join("/"), kind: "directory", children: [] };
          current.push(existing);
        }
        current = existing.children!;
      }

      // Add file node
      const fileName = parts[parts.length - 1];
      current.push({
        name: fileName,
        path: file.path,
        kind: "file",
        content: file.content,
      });
    }

    return root;
  }

  /** Generate a .zip file content using JSZip-like approach (pure JS) */
  async toZip(): Promise<Blob> {
    // Dynamic import JSZip if available, otherwise use a minimal ZIP implementation
    let JSZip: any;
    try {
      JSZip = (await import("jszip")).default;
    } catch {
      // Minimal fallback: just concatenate files with headers
      return this.toTextBundle();
    }

    const zip = new JSZip();
    for (const [path, file] of this.files) {
      zip.file(path, file.content);
    }
    return zip.generateAsync({ type: "blob" });
  }

  /** Fallback: create a tar-like text bundle if JSZip isn't available */
  private toTextBundle(): Blob {
    const parts: string[] = [];
    for (const [path, file] of this.files) {
      parts.push(`=== FILE: ${path} ===`);
      parts.push(file.content);
      parts.push("");
    }
    return new Blob([parts.join("\n")], { type: "text/plain" });
  }

  /** Subscribe to changes */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch {}
    }
  }

  /** Clear all files */
  clear() {
    this.files.clear();
    this.notify();
  }
}

export interface VirtualFileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: VirtualFileNode[];
  content?: string;
}

// Singleton instance
export const virtualFS = new VirtualFileSystem();

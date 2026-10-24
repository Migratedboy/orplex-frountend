"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/components/Toast";

import { apiFetch } from "@/lib/api-base";
// Type-only: the runtime module stays behind the dynamic import below (code
// splitting), but the outcome type is the real one — and unlike
// `Awaited<ReturnType<typeof import(...)>>` it parses for React Compiler.
import type { ReopenOutcome } from "@/lib/project-reopen";
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

// Hard ceiling on total text the renderer keeps in memory (~10 MB). Files
// ALWAYS live on disk — the File System Access handles re-read them on
// demand — so this cache is just the AI's hot working set, not a copy of the
// workspace. Without the cap, indexing (120 × 150 KB), manual reads of huge
// files, and unbounded AI write caching could balloon renderer memory until
// low-RAM machines thrash or crash.
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

// Oversized files are read as a bounded window from disk instead of being
// materialized whole in a string (Blob.slice streams only that byte range).
const READ_WINDOW_CHARS = 200_000;

// Writes/edits larger than this are stored on disk but NOT admitted to the
// in-memory hot-set — one huge entry would evict everything else.
const MAX_CACHE_ENTRY_CHARS = 500_000;

// edit_file does whole-file string replacement; refuse it above this size so
// the operation can never spike memory proportional to a giant file.
const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Insert a file into the cache under the byte budget, evicting the oldest
 * entries first (JS object key order = insertion order). The inserted file is
 * never evicted by its own insert, so a single oversized file is tolerated
 * (it just evicts everything else). Re-inserting an existing path via
 * delete+set makes it freshly-inserted, keeping actively-written files hot.
 */
function insertWithBudget(cache: Record<string, string>, path: string, text: string): Record<string, string> {
  const next: Record<string, string> = {};
  let total = text.length;
  for (const [k, v] of Object.entries(cache)) {
    if (k === path) continue;
    next[k] = v;
    total += v.length;
  }
  for (const k of Object.keys(next)) {
    if (total <= MAX_CACHE_BYTES) break;
    total -= next[k].length;
    delete next[k];
  }
  next[path] = text;
  return next;
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

  // Warm the project-reopen chunks at mount. They stay dynamically imported
  // (code splitting is unchanged), but by the time the user clicks a project
  // row the modules are already in the module cache, so `reopenProject` has no
  // pending chunk-load await sitting between the click and requestPermission.
  // That await was enough to exhaust the click's user-activation window.
  //
  // The persisted handles are pulled in at the same time, so the click path can
  // reach an already-in-memory handle and request permission in the click's own
  // tick — requestPermission rejects with a SecurityError once ANY task (an
  // IndexedDB open, a microtask flush, a chunk fetch) has run since the click.
  const prefetchedHandlesRef = useRef<Map<string, FileSystemDirectoryHandle>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { loadProjectHandle, listProjectsLocal } = await import("@/lib/project-registry");
        for (const p of listProjectsLocal()) {
          const h = await loadProjectHandle(p.name);
          if (cancelled) return;
          if (h) prefetchedHandlesRef.current.set(p.name, h);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void import("@/lib/project-registry").catch(() => {});
    void import("@/lib/project-reopen").catch(() => {});
  }, []);

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

      try {
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
      } catch (err) {
        // One unreadable entry (permission gap, transient IO) must not abort
        // the whole folder open — skip it and keep scanning the rest.
        console.warn(`[workspace] skipping unreadable entry "${path}"`, err);
      }
    }
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, []);

  /**
   * Bulk-read was REMOVED (Freebuff model): eager indexing read up to 120
   * files on every folder open and dominated memory on big workspaces. The
   * AI now pulls files on demand — readFile() streams them from disk (with
   * a ~200 KB window for oversized files) and the 10 MB budget keeps only
   * the hot-set resident. Search runs server-side on disk via ripgrep, not
   * over this cache.
   */

  /**
   * Attach a directory handle as the ACTIVE workspace — the one shared path
   * for both the picker (openFolder) and project re-open (reopenProject):
   * resolve the absolute path → persist handle (IndexedDB) → register the
   * path server-side (/api/agent/workspace-cwd) → scan tree. Returns the file
   * count so callers can surface a toast.
   *
   * NOTE (Freebuff model): no bulk read here. Files stay on disk; the AI reads
   * what it needs on demand (read_file windows oversized files), search runs
   * server-side on disk (ripgrep → git grep → node scan via /api/agent/grep),
   * and the in-memory cache is only the bounded hot-set of files actually
   * touched. Opening a huge folder is instant.
   */
  const openFolderHandle = useCallback(async (handle: FileSystemDirectoryHandle): Promise<{ fileCount: number }> => {
    fileHandlesRef.current.clear();
    setFileContents({});
    setDirectoryHandle(handle);
    setDirectoryName(handle.name);

    // Persist the handle NOW, at the one choke point every attach flow passes
    // through (picker open, sidebar reopen). Without this only handles saved
    // by some other path survived, and reopen after a restart reported
    // "opened on another device" for folders the user plainly opened here
    // (live-observed: psd10 had a handle, Documents never did).
    // Fire-and-forget: an IDB hiccup must not fail the attach.
    try {
      const { saveProjectHandle } = await import("@/lib/project-registry");
      void saveProjectHandle(handle.name, handle);
    } catch {}

    // Resolve the ABSOLUTE path from the directory handle BEFORE anything
    // else. The old flow derived it from a file in fileHandlesRef AFTER a
    // scan that SKIPS whole subtrees (node_modules, .git, .next, dist, ...).
    // A workspace whose root held only ignored entries registered no path at
    // all, so the desktop terminal and the AI's auto-verification failed with
    // "no workspace folder open" while the folder was visibly open. Deriving
    // it from the handle removes that dependency.
    // The File System Access API never exposes paths, so Electron's
    // webUtils.getPathForFile is the only source — getPathForFile is Electron-
    // only, which also means the probe below never runs in a plain browser.
    let absPath = "";
    try {
      const bridge = (window as any).orplexDesktop;
      if (bridge?.getPathForFile) {
        // A created-then-removed probe file is deterministic (the root may
        // hold no regular files we can name) and leaves nothing behind.
        const probeName = ".orplex-path-probe";
        let probeHandle: any = null;
        try {
          probeHandle = await (handle as any).getFileHandle?.(probeName, { create: true });
        } catch {}
        if (probeHandle) {
          try {
            const p = await bridge.getPathForFile(await probeHandle.getFile());
            if (p) absPath = String(p).replace(/[\\/][^\\/]+$/, ""); // strip filename → directory
          } finally {
            try { await (handle as any).removeEntry?.(probeName); } catch {}
          }
        }
      }
      // getPathForFile came back empty — ask the main process by folder name.
      if (!absPath && bridge?.getPathForDirectory) {
        const p = await bridge.getPathForDirectory(handle.name);
        if (p) absPath = String(p);
      }
    } catch {}
    // Never leave the probe behind, whatever failed above.
    try { await (handle as any).removeEntry?.(".orplex-path-probe"); } catch {}
    // Remember the path on the roster entry NOW: resolveDesktopCwd reads
    // `lastPath` from there to hand the desktop terminal its cwd, and project
    // re-open reads it back for Reveal in Explorer.
    if (absPath) {
      try {
        const { setProjectPath } = await import("@/lib/project-registry");
        setProjectPath(window.localStorage, handle.name, absPath);
      } catch {}
    }

    // Silent failure was worse than the error it caused downstream: with no
    // path recorded, the desktop terminal lane resolves cwd to null and
    // EVERY agent command is refused ("no workspace folder path is
    // registered") while the folder looks plainly open. Say so immediately.
    if (!absPath) {
      try {
        toast(
          `Opened "${handle.name}", but its absolute path could not be captured — agent commands may be refused. Close and re-open the project once (via the sidebar) to retry.`,
          "error"
        );
      } catch {}
    }
    const tree = await scanDirectory(handle);
    setFileTree(tree);

    // Register the absolute path server-side so agent terminal commands
    // (npm install, node server.js, ...) run in THIS folder. Empty outside
    // Electron — the server then falls back to its own cwd.
    if (absPath) {
      try {
        const res = await apiFetch("/api/agent/workspace-cwd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: absPath }),
        });
        if (res.ok) {
          toast(`Terminal commands will run in "${absPath}"`, "success");
        } else {
          // Silent failure here was invisible: the folder looked open, yet no
          // cwd was registered, so every later command (AI or manual) failed
          // with a misleading "open a folder first". Say what actually broke.
          const detail = await res.json().catch(() => null);
          toast(
            `Could not register "${absPath}" as the workspace (HTTP ${res.status}${
              (detail as { error?: string } | null)?.error ? ` — ${(detail as { error?: string }).error}` : ""
            }). AI and manual commands will fail until this succeeds.`,
            "error"
          );
        }
      } catch {
        toast(`Could not register "${absPath}" as the workspace — is the app server reachable?`, "error");
      }
    }

    return { fileCount: fileHandlesRef.current.size };
  }, [scanDirectory, toast]);

  // One native folder picker at a time. A second showDirectoryPicker() call
  // while a dialog is still spawning throws NotAllowedError ("File picker
  // already active") — the hero pill, its Ctrl+O shortcut and the workspace
  // switcher can all fire inside that window, and the uncaught rejection used
  // to surface as a dev-overlay console error. Collapse duplicate calls into
  // the in-flight picker instead.
  const pickerInFlightRef = useRef<Promise<void> | null>(null);

  const openFolder = useCallback(async () => {
    if (pickerInFlightRef.current) return pickerInFlightRef.current;
    const run = (async () => {
      try {
        if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
          toast("File System Access API is not supported in this browser. Please use Chrome or Edge.", "error");
          return;
        }

        const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
        const { fileCount } = await openFolderHandle(handle);
        toast(`Mapped "${handle.name}" — ${fileCount} files available to the AI on demand.`, "success");
      } catch (err: any) {
        // AbortError = the user closed the dialog (silent, expected).
        // NotAllowedError "already active" = a second opener raced the first;
        // the guard above makes this rare, but some Electron builds still
        // throw it — treat it the same as a cancel.
        const duplicate = err?.name === "NotAllowedError" && /already active/i.test(err?.message ?? "");
        if (err?.name !== "AbortError" && !duplicate) {
          console.error(err);
          toast(`Error opening folder: ${err.message}`, "error");
        }
      } finally {
        pickerInFlightRef.current = null;
      }
    })();
    pickerInFlightRef.current = run;
    return run;
  }, [openFolderHandle, toast]);

  /**
   * Re-open a previously-opened project by folder NAME (Projects sidebar):
   * load the persisted handle → silent permission query → one prompt if
   * needed → shared openFolderHandle attach → roster touch. Never throws;
   * returns a typed ReopenOutcome the caller can toast. Denied permission
   * leaves the project listed and expandable.
   */
  const reopenProject = useCallback(async (name: string) => {
    // The reopen contract is "never throws" — chunk-load failures of the
    // dynamic imports or any unexpected error become a failed outcome (the
    // project row stays listed), not an uncaught rejection.
    let outcome: ReopenOutcome;
    try {
      const { loadProjectHandle, requestHandlePermission, touchProject } = await import("@/lib/project-registry");
      const { reopenProject: runReopen } = await import("@/lib/project-reopen");

      // requestPermission ONLY succeeds inside the click's synchronous user
      // activation window. Chromium throws
      // "SecurityError: User activation is required" once ANY task has run
      // since the click — and awaiting a dynamic import or an IndexedDB open
      // is a task. We used to await `loadHandle` first, so the prompt was
      // always dead and the SecurityError was swallowed as "denied": a valid,
      // previously-granted project silently refused to reopen.
      //
      // Fix: the handle is prefetched into a ref at mount (see
      // prefetchedHandlesRef), so when it is already in memory we issue the
      // permission request as the FIRST statement of this continuation — the
      // closest thing to the click's own tick that an async function can do.
      // Falls back to the awaited load when the prefetch missed.
      const cached = prefetchedHandlesRef.current.get(name);
      let preGranted: FileSystemDirectoryHandle | null = null;
      if (cached) {
        const anyHandle = cached as any;
        if (typeof anyHandle.requestPermission === "function") {
          try {
            const state: string = await anyHandle.requestPermission({ mode: "readwrite" });
            if (state === "granted") preGranted = cached;
          } catch {
            // Still activation-blocked (e.g. reopened without a click). Let the
            // normal path report the outcome.
          }
        }
      }

      outcome = await runReopen(name, {
        loadHandle: async (n) => preGranted ?? prefetchedHandlesRef.current.get(n) ?? (await loadProjectHandle(n)),
        checkPermission: (h, mode, query) => requestHandlePermission(h, mode, query),
        attach: (h) => openFolderHandle(h),
        touch: (n) => {
          try {
            touchProject(window.localStorage, n);
          } catch {}
        },
      });
    } catch (err: any) {
      outcome = { status: "failed", name, message: `Could not reopen "${name}": ${err?.message || "unknown error"}` };
    }
    if (outcome.status === "ok") {
      toast(outcome.message, "success");
    } else {
      // denied / not-found / invalid / failed — informational, never fatal.
      toast(outcome.message, outcome.status === "denied" ? "info" : "error");
    }
    return outcome;
  }, [openFolderHandle, toast, prefetchedHandlesRef]);

  const readFile = useCallback(async (path: string): Promise<string> => {
    try {
      // Return from cache if already read
      const cached = fileContents[path];
      if (cached !== undefined) return cached;

      const handle = fileHandlesRef.current.get(path);
      if (!handle) return `[Error: file not found at path "${path}"]`;

      const file = await handle.getFile();

      // Oversized files are read as a bounded WINDOW from disk (Blob slice —
      // the browser streams only that byte range), never materialized whole.
      // The full file stays on disk; other ranges are reachable via terminal
      // range tools. This keeps a 100 MB log file from spiking renderer RAM.
      if (file.size > READ_WINDOW_CHARS) {
        let head = await file.slice(0, READ_WINDOW_CHARS).text();
        // A byte slice can split a trailing multibyte char — drop the artifact.
        if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
        const total = file.size;
        const text =
          head +
          `\n\n[…windowed read — first ${READ_WINDOW_CHARS.toLocaleString()} of ${total.toLocaleString()} bytes. The full file stays on disk; use terminal range reads (e.g. sed -n 'X,Yp') for other sections.]`;
        setFileContents(prev => insertWithBudget(prev, path, text));
        return text;
      }

      const text = await file.text();
      // Cache under the byte budget (evicts oldest entries when full).
      setFileContents(prev => insertWithBudget(prev, path, text));
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

      // Anti-clobber guard: oversized files are read as a ~200 KB head window,
      // so a caller that then issues a full write_file has only seen the head.
      // If the on-disk file is far larger than the incoming content, that
      // overwrite would silently destroy the unseen tail — refuse it. (New
      // files are size 0 and never trip this; same 8 MB policy as editFile.)
      const existing = await handle.getFile();
      if (existing.size > MAX_EDIT_FILE_BYTES && content.length < existing.size / 2) {
        toast(
          `Refusing to overwrite ${path}: the file on disk is ${(existing.size / 1048576).toFixed(1)} MB but the incoming content is only ${(content.length / 1024).toFixed(0)} KB — the write looks partial (windowed read) and would destroy the rest of the file. Rewrite big files with terminal streaming tools (sed -i, truncate).`,
          "error"
        );
        return false;
      }

      const writable = await (handle as any).createWritable();
      try {
        await writable.write(content);
        await writable.close();
      } catch (writeErr) {
        // A failed write/close must abort the stream — an OPEN writable
        // locks the file, and every later write to it fails until reload.
        try { await writable.abort(); } catch {}
        throw writeErr;
      }

      // Full content is written to DISK (the source of truth). Only cache the
      // copy when it is small — admitting a huge file would evict the whole
      // hot-set for one entry.
      if (content.length <= MAX_CACHE_ENTRY_CHARS) {
        setFileContents(prev => insertWithBudget(prev, path, content));
      } else {
        setFileContents(prev => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
      }
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

      // Refuse string-replace edits on very large files: computing them needs
      // the whole file in one string, which is exactly the memory spike this
      // module exists to prevent. Large-file edits should go through the
      // terminal (sed/ed) or a full-file write instead.
      if (handle) {
        const stat = await handle.getFile();
        if (stat.size > MAX_EDIT_FILE_BYTES) {
          toast(`File too large for in-app edit (${(stat.size / 1024 / 1024).toFixed(1)} MB) — use the terminal (sed) instead.`, "error");
          return false;
        }
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
      try {
        await writable.write(content);
        await writable.close();
      } catch (writeErr) {
        // A failed write/close must abort the stream — an OPEN writable
        // locks the file, and every later write to it fails until reload.
        try { await writable.abort(); } catch {}
        throw writeErr;
      }

      // Disk holds the truth; the cache copy stays under the byte budget.
      setFileContents(prev => insertWithBudget(prev, filePath, content));
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
    openFolderHandle,
    reopenProject,
    readFile,
    writeFile,
    editFile,
  };
}

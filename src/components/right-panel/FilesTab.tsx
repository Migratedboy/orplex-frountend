"use client";

/**
 * FilesTab.tsx — the Files tab of the right panel: the open workspace as a
 * lazy tree (children load on expand; .git/node_modules/.next hidden).
 *
 * Right Panel v2 (P3):
 * - F1 lazy tree (GET /api/agent/fs?dir=) + chevron state persisted per
 *   workspace; F2 name filter; F3 content-search fallback (POST
 *   /api/agent/grep) when the filter matches nothing loaded.
 * - F4 new file / new folder (inline name input + validation, POST
 *   /api/agent/fs create|mkdir); F5 upload (desktop: fsOps.copySelected with
 *   a native collision prompt; browser: hidden input → base64 create).
 * - F6 click file → viewer (image inline, markdown rendered, text raw).
 * - F7 right-click menu: rename / delete (Recycle Bin on desktop via
 *   fsOps.trash, .orplex trash elsewhere) / reveal / copy path.
 * - F9 writes record through workspace-history server-side (route), so
 *   user-created files show up in Changes and are undoable.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useFileSystemContext } from "../FileSystemProvider";
import { apiFetch } from "@/lib/api-base";
import MarkdownRenderer from "../MarkdownRenderer";
import { FilesPanelSkeleton } from "../PanelSkeletons";
import { RIcon } from "./ref-icons";


interface Entry {
  name: string;
  kind: "file" | "directory";
  size?: number;
}

interface TreeNode {
  name: string;
  kind: "file" | "directory";
  size?: number;
  children?: Entry[] | null; // null = unloaded
}

interface MenuState {
  x: number; y: number; node: { path: string; kind: "file" | "directory" };
}

const LS_PREFIX = "orplex.filesOpenDirs.";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

export function FilesTab() {
  const { directoryName } = useFileSystemContext();
  const { readFile } = useFileSystemContext();

  const [root, setRoot] = useState<TreeNode[] | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState("");
  const [filter, setFilter] = useState("");
  const [grepHits, setGrepHits] = useState<string[] | null>(null);
  const [grepBusy, setGrepBusy] = useState(false);
  const [creating, setCreating] = useState<{ kind: "file" | "folder"; folder: string } | null>(null);
  const [createName, setCreateName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- data loading -------------------------------------------------------
  const load = useCallback(async (dir: string): Promise<Entry[]> => {
    const res = await apiFetch(`/api/agent/fs?dir=${encodeURIComponent(dir)}`);
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    const data = (await res.json()) as { entries?: Entry[]; error?: string };
    return data.entries ?? [];
  }, []);

  const loadRoot = useCallback(async () => {
    try {
      const entries = await load("");
      setRoot(entries.map((e) => ({ ...e, children: e.kind === "directory" ? null : undefined })));
    } catch {
      setRoot([]);
    }
  }, [load]);

  useEffect(() => {
    if (!directoryName) { setRoot(null); return; }
    // Chevron state is per workspace (F1).
    try {
      const saved = JSON.parse(sessionStorage.getItem(LS_PREFIX + directoryName) ?? "[]");
      setOpenDirs(new Set(Array.isArray(saved) ? saved.filter((s) => typeof s === "string") : []));
    } catch { setOpenDirs(new Set()); }
    setSelectedFolder("");
    setFilter("");
    setRoot(null);
    void loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryName]);

  useEffect(() => {
    if (!directoryName) return;
    try { sessionStorage.setItem(LS_PREFIX + directoryName, JSON.stringify([...openDirs])); } catch {}
  }, [openDirs, directoryName]);

  const ensureLoaded = useCallback(
    async (path: string) => {
      // Load children of `path` into the tree cache (root => root nodes).
      try {
        const entries = await load(path);
        setRoot((prev) => {
          if (!prev) return prev;
          if (path === "") return entries.map((e) => ({ ...e, children: e.kind === "directory" ? null : undefined }));
          const insert = (list: TreeNode[], segs: string[]): TreeNode[] =>
            list.map((n) => {
              if (n.kind !== "directory" || segs.length === 0 || n.name !== segs[0]) return n;
              if (segs.length === 1) {
                return { ...n, children: entries.map((e) => ({ ...e, children: e.kind === "directory" ? null : undefined })) };
              }
              return { ...n, children: insert(n.children ?? [], segs.slice(1)) };
            });
          return insert(prev, path.split("/"));
        });
      } catch (e) {
        setNote(`Could not list ${path || "workspace"}: ${(e as Error).message}`);
      }
    },
    [load]
  );

  const toggle = useCallback(async (path: string, isLoaded: boolean) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    const isNowOpen = !openDirs.has(path);
    // openDirs in this closure lags one render behind setState; recompute from
    // the value we just set semantics: open if it wasn't in the prior set.
    if (isNowOpen && !isLoaded) await ensureLoaded(path);
  }, [ensureLoaded, openDirs]);

  // ---- filter + content search (F2/F3) ------------------------------------
  const loadedPaths = useCallback((nodes: TreeNode[] | null, base = ""): Array<{ path: string; name: string }> => {
    if (!nodes) return [];
    const out: Array<{ path: string; name: string }> = [];
    for (const n of nodes) {
      const p = base ? `${base}/${n.name}` : n.name;
      out.push({ path: p, name: n.name });
      if (n.kind === "directory" && openDirs.has(p) && n.children) out.push(...loadedPaths(n.children, p));
    }
    return out;
  }, [openDirs]);

  const nameHits = filter
    ? loadedPaths(root).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : [];
  const showGrep = filter.trim().length >= 3 && root !== null && nameHits.length === 0;

  useEffect(() => {
    if (!showGrep) { setGrepHits(null); return; }
    const q = filter.trim();
    let cancelled = false;
    setGrepBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/agent/grep", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pattern: q }),
        });
        const data = (await res.json()) as { output?: string };
        if (cancelled) return;
        const paths = [...new Set((data.output ?? "").split("\n").map((l) => l.split(":")[0]?.trim()).filter(Boolean))];
        setGrepHits(paths.slice(0, 50));
      } catch {
        if (!cancelled) setGrepHits([]);
      } finally {
        if (!cancelled) setGrepBusy(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [showGrep, filter]);

  useEffect(() => {
    if (!filter.trim()) { setGrepHits(null); return; }
  }, [filter]);

  // ---- writes --------------------------------------------------------------
  const doCreate = async (kind: "file" | "folder") => {
    if (!creating || !createName.trim()) return;
    setBusy(true);
    try {
      const path = creating.folder ? `${creating.folder}/${createName.trim()}` : createName.trim();
      const res = await apiFetch("/api/agent/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: kind === "file" ? "create" : "mkdir", path }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || "Create failed");
      setCreating(null);
      setCreateName("");
      setNote(kind === "file" ? `Created ${path}` : `Created folder ${path}`);
      await ensureLoaded(creating.folder);
      // New folder chevron opens on it.
      if (kind === "folder") setOpenDirs((p) => new Set(p).add(creating.folder));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!renaming || !renaming.name.trim()) return;
    const parent = renaming.path.includes("/") ? renaming.path.slice(0, renaming.path.lastIndexOf("/")) : "";
    const to = parent ? `${parent}/${renaming.name.trim()}` : renaming.name.trim();
    setBusy(true);
    try {
      const res = await apiFetch("/api/agent/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "rename", from: renaming.path, to }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || "Rename failed");
      setRenaming(null);
      setNote(`Renamed to ${to}`);
      await ensureLoaded(parent);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const absPath = async (rel: string): Promise<string> => {
    if (!directoryName) return rel;
    const base = (await window.orplexDesktop?.getPathForDirectory?.(directoryName)) ?? directoryName;
    return rel ? `${base}\\${rel.replace(/\//g, "\\")}` : base;
  };

  const doDelete = async (node: { path: string; kind: "file" | "directory" }) => {
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    const label = node.kind === "directory" ? "folder (and everything in it)" : "file";
    if (!window.confirm(`Move this ${label} to the trash?`)) return;
    setBusy(true);
    try {
      // Desktop → Recycle Bin; browser → .orplex trash via the route.
      if (window.orplexDesktop?.fsOps) {
        const r = await window.orplexDesktop.fsOps.trash(await absPath(node.path));
        if (!r.ok) throw new Error(r.error || "Trash failed");
      } else {
        const res = await apiFetch("/api/agent/fs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "delete", path: node.path }),
        });
        const data = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !data.success) throw new Error(data.error || "Delete failed");
      }
      setNote(`Moved to trash: ${node.path}`);
      await ensureLoaded(parent);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Upload (F5): desktop = native dialog (collision prompt inside main);
  // browser = hidden input, text ≤10 MB goes through create as base64.
  const doUpload = async () => {
    const folder = selectedFolder;
    setBusy(true);
    try {
      if (window.orplexDesktop?.fsOps) {
        const r = await window.orplexDesktop.fsOps.copySelected(await absPath(folder), "keep");
        if (!r.ok && r.error !== "cancelled") throw new Error(r.error || "Upload failed");
        if (!r.ok && r.error === "cancelled") return;
        setNote(r.copied.length ? `Uploaded ${r.copied.length} file(s)` : "Upload cancelled");
      } else {
        fileInputRef.current?.click();
        return; // continuation in onFilePicked
      }
      await ensureLoaded(folder);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          setNote(`${f.name}: over 10 MB — upload needs the desktop app`);
          continue;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(f);
        });
        const contentBase64 = dataUrl.split(",")[1] ?? "";
        const path = selectedFolder ? `${selectedFolder}/${f.name}` : f.name;
        const res = await apiFetch("/api/agent/fs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "create", path, contentBase64 }),
        });
        const data = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !data.success) throw new Error(data.error || `Upload failed: ${f.name}`);
      }
      setNote(`Uploaded ${files.length} file(s)`);
      await ensureLoaded(selectedFolder);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!directoryName) {
    return (
      <div className="rp-v2-fl">
        <div className="rp-v2-fl-empty">No folder opened — use Open in the sidebar</div>
      </div>
    );
  }
  if (root === null) {
    return (
      <div className="rp-v2-fl">
        <FilesPanelSkeleton />
      </div>
    );
  }

  const visibleTree = filter
    ? root.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()))
    : null;

  const collectTree = (nodes: TreeNode[] | null, base: string, depth: number): Array<{ node: TreeNode; path: string; depth: number }> => {
    const out: Array<{ node: TreeNode; path: string; depth: number }> = [];
    for (const n of nodes ?? []) {
      const p = base ? `${base}/${n.name}` : n.name;
      if (filter && !(n.name.toLowerCase().includes(filter.toLowerCase()) || (n.kind === "directory" && openDirs.has(p)))) continue;
      out.push({ node: n, path: p, depth });
      if (n.kind === "directory" && openDirs.has(p) && n.children) out.push(...collectTree(n.children, p, depth + 1));
    }
    return out;
  };
  const shown = filter && visibleTree ? visibleTree.map((n) => ({ node: n, path: n.name, depth: 0 })) : collectTree(root, "", 0);

  const openViewer = (path: string) => setViewer(path);

  return (
    <div className="rp-v2-fl">
      <div className="rp-v2-fl-bar">
        <label className="rp-v2-fl-search">
          <span className="rp-v2-fl-search-ic" aria-hidden="true"><RIcon name="search" size={16} /></span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files"
            spellCheck={false}
            aria-label="Filter files"
          />
        </label>
        <button className="rp-v2-fl-btn" title={`New file in ${selectedFolder || "workspace"}`} onClick={() => setCreating({ kind: "file", folder: selectedFolder })}>
          <RIcon name="fileplus" size={18} />
        </button>
        <button className="rp-v2-fl-btn" title={`New folder in ${selectedFolder || "workspace"}`} onClick={() => setCreating({ kind: "folder", folder: selectedFolder })}>
          <RIcon name="folderplus" size={18} />
        </button>
        <button className="rp-v2-fl-btn" title={`Upload to ${selectedFolder || "workspace"}`} onClick={() => void doUpload()} disabled={busy}>
          <RIcon name="upload" size={18} />
        </button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void onFilePicked(e.target.files)} />
      </div>

      {busy && <div className="rp-v2-fl-note" aria-live="polite">Working…</div>}
      {note && !busy && <div className="rp-v2-fl-note" aria-live="polite">{note}</div>}

      <div className="rp-v2-fl-scroll rp-v2-scroll">
        {creating && (
          <div className="rp-v2-fl-create">
            <span className="rp-v2-fl-create-label">{creating.kind === "file" ? "New file" : "New folder"} in {creating.folder || "workspace"}:</span>
            <input
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doCreate(creating.kind);
                if (e.key === "Escape") setCreating(null);
              }}
              placeholder={creating.kind === "file" ? "name.ts" : "my-folder"}
              aria-label="New entry name"
            />
            <button className="rp-v2-fl-ok" onClick={() => void doCreate(creating.kind)} disabled={busy}>Create</button>
            <button className="rp-v2-fl-cancel" onClick={() => setCreating(null)}>Cancel</button>
          </div>
        )}

        {showGrep ? (
          <div>
            {grepBusy ? <div className="rp-v2-fl-empty-grep">Searching file contents…</div> : (grepHits ?? []).length > 0 ? (
              (grepHits ?? []).map((p) => (
                <div key={p} className="rp-v2-fl-hit" onClick={() => openViewer(p)}>
                  <span className="rp-v2-fl-hit-name">{p.split("/").pop()}</span>
                  <span className="rp-v2-fl-hit-dir">{p.split("/").slice(0, -1).join("/")}</span>
                </div>
              ))
            ) : (
              <div className="rp-v2-fl-empty-grep">No matches in file contents</div>
            )}
          </div>
        ) : shown.length === 0 ? (
          <div className="rp-v2-fl-empty">No files found</div>
        ) : (
          shown.map(({ node, path, depth }) => {
            const isDir = node.kind === "directory";
            const isOpen = openDirs.has(path);
            const selected = path === selectedFolder;
            return (
              <div
                key={path}
                className={`rp-v2-fl-row ${selected ? "sel" : ""}`}
                style={{ paddingLeft: 6 + depth * 16 }}
                onClick={async () => {
                  if (isDir) {
                    setSelectedFolder(path);
                    await toggle(path, node.children !== null);
                  } else {
                    openViewer(path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, node: { path, kind: node.kind } });
                }}
              >
                <span className={`rp-v2-fl-chev ${isOpen ? "open" : ""}`} aria-hidden="true">
                  {isDir ? <RIcon name="chev" size={14} /> : null}
                </span>
                <span className="rp-v2-fl-fi" aria-hidden="true">
                  {isDir ? <RIcon name="folder" size={16} /> : <RIcon name="file" size={16} />}
                </span>
                <span className="rp-v2-fl-nm">{node.name}</span>
                {isDir && node.children === null && <span className="rp-v2-fl-dim">(…)</span>}
              </div>
            );
          })
        )}
      </div>

      {renaming && (
        <div className="rp-v2-fl-create">
          <span className="rp-v2-fl-create-label">Rename to:</span>
          <input
            autoFocus
            value={renaming.name}
            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            aria-label="Renamed name"
          />
          <button className="rp-v2-fl-ok" onClick={() => void doRename()} disabled={busy}>Rename</button>
          <button className="rp-v2-fl-cancel" onClick={() => setRenaming(null)}>Cancel</button>
        </div>
      )}

      {menu && (
        <FilesContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpen={(n) => { if (n.kind === "directory") { setSelectedFolder(n.path); void toggle(n.path, false); } else openViewer(n.path); }}
          onNewFile={(f) => setCreating({ kind: "file", folder: f })}
          onNewFolder={(f) => setCreating({ kind: "folder", folder: f }) }
          onRename={(n) => setRenaming({ path: n.path, name: n.path.split("/").pop() ?? n.path })}
          onDelete={(n) => void doDelete(n)}
          onCopyPath={async (n) => {
            const abs = await absPath(n.path);
            try { await navigator.clipboard.writeText(abs); setNote(`Copied path: ${abs}`); }
            catch { setNote(abs); }
          }}
          onReveal={async (n) => {
            const abs = await absPath(n.path);
            const ok = await window.orplexDesktop?.revealPath?.(abs);
            if (!ok) setNote("Reveal needs the desktop app");
          }}
          canReveal={typeof window !== "undefined" && !!window.orplexDesktop?.revealPath}
        />
      )}

      {viewer && (
        <FileViewer
          path={viewer}
          onClose={() => setViewer(null)}
          readText={async (p) => readFile(p).catch(() => "")}
        />
      )}
    </div>
  );
}

// ---- context menu ---------------------------------------------------------

function FilesContextMenu(props: {
  menu: MenuState;
  onClose: () => void;
  onOpen: (n: MenuState["node"]) => void;
  onNewFile: (folder: string) => void;
  onNewFolder: (folder: string) => void;
  onRename: (n: MenuState["node"]) => void;
  onDelete: (n: MenuState["node"]) => void;
  onCopyPath: (n: MenuState["node"]) => void;
  onReveal: (n: MenuState["node"]) => void;
  canReveal: boolean;
}) {
  const { menu, onClose } = props;
  const n = menu.node;
  const folderOf = n.kind === "directory" ? n.path : (n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "");
  const act = (fn: (n: MenuState["node"]) => void, arg: MenuState["node"] = n, folder?: string) => {
    fn(folder !== undefined ? { path: folder, kind: "directory" } : arg);
    onClose();
  };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".rp-v2-fl-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const item = (label: string, icon: React.ReactNode, fn: () => void, disabled = false) => (
    <button key={label} className="rp-v2-fl-menu-item" disabled={disabled} onClick={fn}>
      {icon}{label}
    </button>
  );
  return (
    <div className="rp-v2-fl-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 260) }}>
      {item("Open", <RIcon name="file" size={15} />, () => act(props.onOpen))}
      {item("New file here…", <RIcon name="fileplus" size={15} />, () => { props.onNewFile(folderOf); onClose(); })}
      {item("New folder here…", <RIcon name="folderplus" size={15} />, () => { props.onNewFolder(folderOf); onClose(); })}
      <div className="rp-v2-fl-menu-sep" />
      {item("Rename…", <RIcon name="pen" size={15} />, () => act(props.onRename))}
      {item("Copy path", <RIcon name="file" size={15} />, () => { void props.onCopyPath(n); onClose(); })}
      {item("Reveal in Explorer", <RIcon name="folder" size={15} />, () => { void props.onReveal(n); onClose(); }, !props.canReveal)}
      <div className="rp-v2-fl-menu-sep" />
      {item("Delete (to trash)…", <RIcon name="fdel" size={15} />, () => { void props.onDelete(n); onClose(); })}
    </div>
  );
}

// ---- file viewer ----------------------------------------------------------

function FileViewer({ path, onClose, readText }: { path: string; onClose: () => void; readText: (p: string) => Promise<string> }) {
  const [text, setText] = useState<string | null>(null);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXT.has(ext);
  const isMd = ext === "md" || ext === "markdown" || ext === "mdx";

  useEffect(() => {
    if (isImage) return;
    let alive = true;
    void readText(path).then((t) => { if (alive) setText(t); });
    return () => { alive = false; };
  }, [path, isImage, readText]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const name = path.split("/").pop() ?? path;

  return (
    <div className="rp-v2-viewer-overlay" onClick={onClose}>
      <div className="rp-v2-viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`View ${name}`}>
        <div className="rp-v2-viewer-head">
          <span className="rp-v2-viewer-path" title={path}>
            {dir && <span className="rp-v2-viewer-dir">{dir}/</span>}{name}
          </span>
          <button className="rp-v2-viewer-x" onClick={onClose} aria-label="Close viewer" title="Close (Esc)"><RIcon name="x" size={16} /></button>
        </div>
        <div className="rp-v2-viewer-body">
          {isImage ? (
            // Served by the LOCAL_ONLY fs route (device-local bytes).
            // next/image would proxy through the Next server — no benefit.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/agent/fs?file=${encodeURIComponent(path)}`} alt={name} className="rp-v2-viewer-img" />
          ) : isMd ? (
            text === null ? <div className="rp-v2-fl-empty">Loading…</div> : <MarkdownRenderer content={text} />
          ) : (
            text === null ? <div className="rp-v2-fl-empty">Loading…</div> : <pre className="rp-v2-viewer-pre">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}


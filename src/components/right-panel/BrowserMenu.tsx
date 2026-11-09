"use client";

/**
 * BrowserMenu.tsx — the "…" Browser settings menu (Right Panel v2, P5).
 * Every item is real: new page, private tab, devtools, hard reload, floating
 * window, record, import dialog, extensions dialog, recent pages (history
 * store), profiles (CRUD + switch), browser data (sizes + clear).
 */
import { useCallback, useEffect, useState } from "react";
import {
  IconPlus, IconMask, IconCode, IconRefresh, IconPuzzle, IconVideo,
  IconDownload, IconHistory, IconProfile, IconDatabase, IconChevronDown, IconCheck, IconX,
} from "../Icons";

type MenuAction = "new" | "private" | "devtools" | "hard" | "float" | "record" | "import" | "ext" | "recent" | "profiles" | "bdata";

type ItemEntry = { id: MenuAction; icon: React.ReactNode; label: string; sub?: boolean | "profiles" } | { sep: true };
const ITEMS: ItemEntry[] = [
  { id: "new", icon: <IconPlus size={16} />, label: "New browser page" },
  { id: "private", icon: <IconMask size={16} />, label: "Private tab" },
  { id: "devtools", icon: <IconCode size={16} />, label: "Open DevTools" },
  { id: "hard", icon: <IconRefresh size={16} />, label: "Hard reload" },
  { id: "float", icon: <IconPuzzle size={16} />, label: "Toggle floating preview" },
  { id: "record", icon: <IconVideo size={16} />, label: "Record browser" },
  { sep: true },
  { id: "import", icon: <IconDownload size={16} />, label: "Import browser data…" },
  { id: "ext", icon: <IconPuzzle size={16} />, label: "Extensions…" },
  { sep: true },
  { id: "recent", icon: <IconHistory size={16} />, label: "Recent pages", sub: true },
  { id: "profiles", icon: <IconProfile size={16} />, label: "Profiles", sub: true },
  { id: "bdata", icon: <IconDatabase size={16} />, label: "Browser data", sub: true },
];

export interface BrowserMenuProps {
  open: boolean;
  onClose: () => void;
  /** Active renderer tab id (main-side view lookup). */
  tabId: number;
  /** Tab ids for the profile-switch re-create; BrowserTab owns them. */
  tabIds: number[];
  privateIds: number[];
  floating: boolean;
  recording: boolean;
  /** Renderer-side actions the bridge (window) can't do alone. */
  onNew(): void;
  onPrivate(): Promise<void>;
  onFloat(): void;
  onRecord(): void;
  onImport(openExtensions?: boolean): void;
  onNavigate(url: string): void;
  onSwitchProfile(profileId: string): void;
}

export function BrowserMenu(props: BrowserMenuProps) {
  const { open, onClose } = props;
  const bridge = typeof window !== "undefined" ? window.orplexDesktop?.previewExtras : undefined;
  const [openSubs, setOpenSubs] = useState<Set<MenuAction>>(new Set());
  const [history, setHistory] = useState<Array<{ url: string; at: number }>>([]);
  const [profiles, setProfiles] = useState<{ list: Array<{ id: string; label: string }>; active: string }>({ list: [], active: "default" });
  const [sizes, setSizes] = useState<{ cache?: number; storage?: number }>({});
  const [note, setNote] = useState("");
  const [newProfileLabel, setNewProfileLabel] = useState("");
  const [creatingProfile, setCreatingProfile] = useState(false);

  const loadProfiles = useCallback(async () => {
    if (!bridge) return;
    try {
      const r = await bridge.listProfiles();
      setProfiles({ list: r.profiles, active: r.activeId });
    } catch {}
  }, [bridge]);

  const loadHistory = useCallback(async () => {
    if (!bridge) return;
    try { setHistory(await bridge.historyList()); } catch {}
  }, [bridge]);

  const loadSizes = useCallback(async () => {
    if (!bridge) return;
    const [c, s] = await Promise.all([
      bridge.dataSizes("cache").catch(() => null),
      bridge.dataSizes("storage").catch(() => null),
    ]);
    setSizes({ cache: c?.bytes, storage: s?.bytes });
  }, [bridge]);

  useEffect(() => {
    if (!open) return;
    setOpenSubs(new Set());
    setNote("");
    setCreatingProfile(false);
    void loadProfiles();
  }, [open, loadProfiles]);

  useEffect(() => {
    if (openSubs.has("recent")) void loadHistory();
    if (openSubs.has("profiles")) void loadProfiles();
    if (openSubs.has("bdata")) void loadSizes();
  }, [openSubs, loadHistory, loadProfiles, loadSizes]);

  if (!open || !bridge) return null;

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const act = (id: MenuAction) => {
    if (id === "recent" || id === "profiles" || id === "bdata") {
      setOpenSubs((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    void onClose();
    switch (id) {
      case "new": props.onNew(); break;
      case "private": void props.onPrivate().catch((e: Error) => setNote(e.message)); break;
      case "devtools":
        void bridge.openDevTools(props.tabId).then((r) => setNote(r.ok ? "" : r.error || "DevTools failed"));
        break;
      case "hard":
        void bridge.hardReload(props.tabId).then((r) => setNote(r.ok ? "" : r.error || "Hard reload failed"));
        break;
      case "float": props.onFloat(); break;
      case "record": props.onRecord(); break;
      case "import": props.onImport(); break;
      case "ext": props.onImport(true); break;
    }
  };

  const toggleSub = (id: MenuAction) => {
    setOpenSubs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fmtBytes = (n?: number) => {
    if (n === undefined) return "…";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderSub = (id: MenuAction) => {
    if (id === "recent") {
      const unique = [...new Set(history.map((h) => h.url))].slice(0, 8);
      if (unique.length === 0) return <div className="rp-v2-bm-none">No recent pages</div>;
      return (
        <>
          {unique.map((u) => (
            <button key={u} className="rp-v2-bm-item" onClick={() => { onClose(); props.onNavigate(u); }}>
              {u.replace(/^https?:\/\//, "")}
            </button>
          ))}
          <div className="rp-v2-bm-sep" />
          <button className="rp-v2-bm-item" onClick={() => { void bridge.historyClear().then(() => setHistory([])); }}>
            Clear history
          </button>
        </>
      );
    }
    if (id === "profiles") {
      return (
        <>
          {profiles.list.map((p) => (
            <button
              key={p.id}
              className="rp-v2-bm-item"
              onClick={() => { onClose(); props.onSwitchProfile(p.id); }}
            >
              {p.label}{p.id === profiles.active ? " ✓" : ""}
            </button>
          ))}
          {creatingProfile ? (
            <div className="rp-v2-bm-create">
              <input
                autoFocus
                value={newProfileLabel}
                onChange={(e) => setNewProfileLabel(e.target.value)}
                placeholder="New profile name"
                name="new-profile"
                aria-label="New profile name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void bridge.createProfile(newProfileLabel || "New profile").then((r) => {
                      if (r.ok) { setCreatingProfile(false); setNewProfileLabel(""); void loadProfiles(); }
                      else setNote(r.error || "Create failed");
                    });
                  }
                }}
              />
              <button onClick={() => setCreatingProfile(false)} aria-label="Cancel"><IconX size={13} /></button>
            </div>
          ) : (
            <button className="rp-v2-bm-item" onClick={() => setCreatingProfile(true)}>+ New profile…</button>
          )}
          {profiles.list
            .filter((p) => p.id !== "default" && p.id !== profiles.active)
            .map((p) => (
              <button key={`del-${p.id}`} className="rp-v2-bm-item rp-v2-bm-danger" onClick={() => {
                void bridge.deleteProfile(p.id).then((r) => {
                  if (r.ok) void loadProfiles();
                  else setNote(r.error || "Delete failed");
                });
              }}>
                Delete {p.label}
              </button>
            ))}
          <ProfilesRenameRow bridge={bridge} list={profiles.list} onDone={() => void loadProfiles()} />
          <div className="rp-v2-bm-note">Switching recreates tabs on the new profile (pages reset; nothing else changes).</div>
        </>
      );
    }
    if (id === "bdata") {
      const item = (label: string, kind: "cache" | "cookies" | "sitedata" | "history") => (
        <button
          key={kind}
          className="rp-v2-bm-item"
          onClick={() => {
            const sure = window.confirm(`Clear ${label.toLowerCase()} from this browser profile?`);
            if (!sure) return;
            void bridge.clearData(kind).then((r) => {
              setNote(r.ok ? `Cleared ${label.toLowerCase()}` : r.error || "Clear failed");
              void loadSizes();
            });
          }}
        >
          <span className="rp-v2-bm-label">{label}</span>
        </button>
      );
      return (
        <>
          {item("Clear cache", "cache")}
          <div className="rp-v2-bm-sub-note">Cache size: {fmtBytes(sizes.cache)}</div>
          {item("Clear cookies", "cookies")}
          {item("Clear site data", "sitedata")}
          {item("Clear history", "history")}
          <div className="rp-v2-bm-sub-note">Site storage: {fmtBytes(sizes.storage)}</div>
        </>
      );
    }
    return null;
  };

  return (
    <div className="rp-v2-bm" role="menu" aria-label="Browser settings" onKeyDown={onMenuKey}>
      {note && <div className="rp-v2-bm-note" aria-live="polite">{note}</div>}
      {ITEMS.map((item, i) => {
        if ("sep" in item) return <hr key={`hr-${i}`} className="rp-v2-bm-sep-hr" />;
        const { id } = item;
        const isOpen = openSubs.has(id);
        const label = id === "record" && props.recording ? "Stop recording" : item.label;
        return (
          <div key={id}>
            <button
              className="rp-v2-bm-item"
              role="menuitem"
              onClick={() => act(id)}
              title={id === "float" && props.floating ? "Docked — click to dock" : item.label}
            >
              <span className="rp-v2-bm-ic">{item.icon}</span>
              {label}
              {id === "record" && props.recording && <span className="rp-v2-bm-rec" aria-hidden="true" />}
              {item.sub && <span className={`rp-v2-bm-chev ${isOpen ? "open" : ""}`}><IconChevronDown size={15} /></span>}
            </button>
            {item.sub && isOpen && <div className="rp-v2-bm-sub">{renderSub(id)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ProfilesRenameRow({ bridge, list, onDone }: {
  bridge: {
    renameProfile: (id: string, label: string) => Promise<{ ok: boolean; error?: string }>;
  };
  list: Array<{ id: string; label: string }>;
  onDone: () => void;
}) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  if (list.length === 0) return null;
  return (
    <div className="rp-v2-bm-create">
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Profile to rename">
        <option value="">Rename profile…</option>
        {list.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {id && (
        <>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New label" aria-label="New profile label" />
          <button
            onClick={() => {
              if (!label.trim()) return;
              void bridge?.renameProfile(id, label.trim()).then((r) => {
                if (r.ok) { setId(""); setLabel(""); onDone(); }
              });
            }}
            aria-label="Save renamed profile"
          >
            <IconCheck size={13} />
          </button>
        </>
      )}
    </div>
  );
}

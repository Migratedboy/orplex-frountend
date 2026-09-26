"use client";

import { useCallback, useEffect, useState } from "react";
import { useFileSystemContext } from "./FileSystemProvider";
import { apiFetch } from "@/lib/api-base";

// MemoryPanel — "What I remember about this workspace". Every entry is
// evidence-backed (captured from verified runs) and user-controllable:
// forget is per-entry, instant, and honest. Empty by design in new workspaces.

interface MemoryEntry {
  id: string;
  kind: string;
  content: string;
  count: number;
  lastSeenAt: string;
}

const KIND_META: Record<string, { tag: string; color: string }> = {
  stack: { tag: "STACK", color: "#2563eb" },
  pattern: { tag: "PATTERN", color: "#7c3aed" },
  decision: { tag: "USER PREF", color: "#15803d" },
  pitfall: { tag: "AVOID", color: "#b91c1c" },
};

export default function MemoryPanel({ onClose }: { onClose: () => void }) {
  // Workspace identity comes from the open folder (the same directoryName the
  // worker uses as its memory key), so callers don't need to thread it.
  const { directoryName } = useFileSystemContext() as { directoryName: string | null };
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!directoryName) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ directoryName });
      const res = await apiFetch(`/api/agent/memory?${params}`);
      const data = await res.json();
      if (data.success) setMemories(data.memories || []);
    } catch {}
    setLoading(false);
  }, [directoryName]);

  useEffect(() => {
    if (directoryName) load();
    else setLoading(false);
  }, [directoryName, load]);

  const forget = useCallback(
    async (id: string) => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      try {
        const params = new URLSearchParams({ id, directoryName: directoryName || "" });
        await apiFetch(`/api/agent/memory?${params}`, { method: "DELETE" });
      } catch {
        load(); // optimistic delete failed — restore truth
      }
    },
    [directoryName, load]
  );

  return (
    <div className="memory-panel flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-label uppercase tracking-wide text-on-surface-variant">
          What I remember about this workspace
        </div>
        <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-sm" aria-label="Close">
          ✕
        </button>
      </div>

      {loading ? (
        <div className="text-[11px] font-mono text-on-surface-variant py-2">loading…</div>
      ) : !directoryName ? (
        <div className="text-[11px] font-mono text-on-surface-variant py-2">
          Open a workspace folder to see its learnings.
        </div>
      ) : memories.length === 0 ? (
        <div className="text-[11px] font-mono text-on-surface-variant py-2">
          Nothing yet. Memories appear after tasks complete with passing verification in this workspace.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
          {memories.map((m) => {
            const meta = KIND_META[m.kind] || { tag: m.kind.toUpperCase(), color: "#71717a" };
            return (
              <div
                key={m.id}
                className="flex items-start gap-2 text-[11px] font-mono border border-surface-variant rounded px-2 py-1.5"
              >
                <span className="shrink-0 font-label text-[9px] px-1 rounded" style={{ color: meta.color }}>
                  [{meta.tag}]
                </span>
                <span className="flex-1 break-words">{m.content}</span>
                {m.count > 1 && (
                  <span className="shrink-0 text-on-surface-variant" title={`seen ${m.count}×`}>
                    ×{m.count}
                  </span>
                )}
                <button
                  onClick={() => forget(m.id)}
                  className="shrink-0 text-on-surface-variant hover:text-red-500"
                  title="Forget this entry"
                >
                  forget
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

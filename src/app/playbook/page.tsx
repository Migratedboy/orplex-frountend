"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api-base";

interface PlaybookEntry {
  id: string;
  pattern: string;
  content: string;
  tags: string[];
  confidence: number;
  verified: boolean;
  useCount: number;
  pinned: boolean;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

const PATTERN_COLORS: Record<string, string> = {
  "file-layout": "bg-blue-500/20 text-blue-300",
  "typecheck-fix": "bg-green-500/20 text-green-300",
  stack: "bg-purple-500/20 text-purple-300",
  skill: "bg-yellow-500/20 text-yellow-300",
};

export default function PlaybookPage() {
  const [entries, setEntries] = useState<PlaybookEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState("");

  // Monotonic request token: only the latest list/search response may write
  // state, so rapid Search → Clear → Search can't resolve out of order.
  const requestToken = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const token = ++requestToken.current;
    setLoading(true);
    setError(null);
    apiFetch("/api/playbook")
      .then((r) => {
        if (!r.ok) throw new Error(`Playbook list failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (token !== requestToken.current) return; // superseded
        setEntries(d.entries || []);
      })
      .catch((err) => {
        if (token !== requestToken.current) return; // superseded
        setEntries([]);
        setError(err instanceof Error ? err.message : "Failed to load playbook");
      })
      .finally(() => {
        if (token === requestToken.current) setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const doSearch = useCallback(() => {
    if (!search.trim()) { load(); return; }
    const token = ++requestToken.current;
    setLoading(true);
    setError(null);
    apiFetch(`/api/playbook?q=${encodeURIComponent(search)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Playbook search failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (token !== requestToken.current) return; // superseded
        setEntries(d.results || []);
      })
      .catch((err) => {
        if (token !== requestToken.current) return; // superseded
        setEntries([]);
        setError(err instanceof Error ? err.message : "Search failed");
      })
      .finally(() => {
        if (token === requestToken.current) setLoading(false);
      });
  }, [search, load]);

  const mutate = async (id: string, init: RequestInit, after: () => void) => {
    setBusy(id);
    try {
      const res = await apiFetch(`/api/playbook/${id}`, init);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(
          (data && typeof data.error === "string" && data.error) ||
          `Request failed (${res.status})`
        );
        return; // do NOT reload — the list on screen is still accurate
      }
      after();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy("");
    }
  };

  const togglePin = (id: string, pinned: boolean) =>
    mutate(id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !pinned }),
    }, () => {});

  const saveEdit = (id: string) =>
    mutate(id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editContent }),
    }, () => setEditing(null));

  const remove = (id: string) =>
    mutate(id, { method: "DELETE" }, () => {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Loading playbook…
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Playbook</h1>
        <span className="text-sm text-gray-400">{entries.length} entries</span>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
          placeholder="Search playbooks…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={doSearch}
          disabled={loading}
          aria-busy={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          Search
        </button>
        {search && (
          <button
            onClick={() => { setSearch(""); load(); }}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="text-center text-gray-500 py-12">
          No playbook entries yet. Complete a verified task to derive learnings.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        PATTERN_COLORS[entry.pattern] || "bg-gray-600 text-gray-300"
                      }`}
                    >
                      {entry.pattern}
                    </span>
                    <span className="text-xs text-gray-500">
                      {Math.round(entry.confidence * 100)}% confidence
                    </span>
                    {entry.useCount > 1 && (
                      <span className="text-xs text-gray-500">
                        used {entry.useCount}×
                      </span>
                    )}
                    {entry.pinned && (
                      <span className="text-xs text-yellow-400">📌 pinned</span>
                    )}
                  </div>
                  {editing === entry.id ? (
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      rows={3}
                    />
                  ) : (
                    <p className="text-gray-200 text-sm">{entry.content}</p>
                  )}
                  {entry.tags.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {entry.tags.map((t, i) => (
                        <span
                          key={`${t}-${i}`}
                          className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  {editing === entry.id ? (
                    <>
                      <button
                        onClick={() => saveEdit(entry.id)}
                        disabled={busy === entry.id}
                        className="text-xs px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="text-xs px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditing(entry.id);
                          setEditContent(entry.content);
                        }}
                        className="text-xs px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => togglePin(entry.id, entry.pinned)}
                        disabled={busy === entry.id}
                        className="text-xs px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                      >
                        {entry.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        onClick={() => remove(entry.id)}
                        disabled={busy === entry.id}
                        className="text-xs px-2 py-1 bg-red-600/80 hover:bg-red-500 text-white rounded transition-colors"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

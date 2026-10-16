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

const PATTERN_CLASS = "pb-tag";

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
      <div className="pb-empty" style={{ paddingTop: 96 }}>
        Loading playbook…
      </div>
    );
  }

  return (
      <div className="pb-wrap">
        <div className="pb-head">
          <h1 className="pb-title">Playbook</h1>
          <span className="pb-count">{entries.length} entries</span>
        </div>

        {error && <div className="pb-error">{error}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
            placeholder="Search playbooks…"
            className="pb-input"
          />
          <button
            onClick={doSearch}
            disabled={loading}
            aria-busy={loading}
            className="pb-btn pb-btn--primary"
          >
            Search
          </button>
          {search && (
            <button
              onClick={() => { setSearch(""); load(); }}
              className="pb-btn"
            >
              Clear
            </button>
          )}
        </div>

        {entries.length === 0 ? (
          <div className="pb-empty">
            No playbook entries yet. Complete a verified task to derive learnings.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {entries.map((entry) => (
              <div key={entry.id} className="pb-card">
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span className={PATTERN_CLASS}>{entry.pattern}</span>
                      <span className="pb-meta">{Math.round(entry.confidence * 100)}% confidence</span>
                      {entry.useCount > 1 && (
                        <span className="pb-meta">used {entry.useCount}×</span>
                      )}
                      {entry.pinned && <span className="pb-meta">📌 pinned</span>}
                    </div>
                    {editing === entry.id ? (
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="pb-textarea"
                        rows={3}
                      />
                    ) : (
                      <p className="pb-body">{entry.content}</p>
                    )}
                    {entry.tags.length > 0 && (
                      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                        {entry.tags.map((t, i) => (
                          <span key={`${t}-${i}`} className="pb-chip">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {editing === entry.id ? (
                      <>
                        <button
                          onClick={() => saveEdit(entry.id)}
                          disabled={busy === entry.id}
                          className="pb-btn pb-btn--primary"
                        >
                          Save
                        </button>
                        <button onClick={() => setEditing(null)} className="pb-btn">
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
                          className="pb-btn"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => togglePin(entry.id, entry.pinned)}
                          disabled={busy === entry.id}
                          className="pb-btn"
                        >
                          {entry.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          onClick={() => remove(entry.id)}
                          disabled={busy === entry.id}
                          className="pb-btn pb-btn--danger"
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

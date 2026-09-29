"use client";
import React, { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-base";

interface Model {
  id: string;
  name: string;
  provider: string;
  detail?: string;
}

// Fallback when the live catalog hasn't landed yet (server sweep runs in the
// background). These ids are probed-live by the platform catalog.
const FALLBACK: Model[] = [
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", provider: "Groq", detail: "free" },
  { id: "qwen/qwen3.8-27b:free", name: "Qwen 3.8 27B", provider: "OpenRouter", detail: "free" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super", provider: "OpenRouter", detail: "free" },
];

interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (modelId: string) => void;
}

export default function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [limit, setLimit] = useState(50);
  const [query, setQuery] = useState("");

  // Live catalog (platform-verified + the user's BYOK listings), fetched on
  // every open so newly added API keys show up without a reload.
  useEffect(() => {
    if (!open || models.length > 0) return;
    let cancelled = false;
    apiFetch("/api/models/available")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { models?: Model[]; userModels?: Model[] }) => {
        if (cancelled) return;
        const merged = [...(j.models ?? []), ...(j.userModels ?? [])];
        const seen = new Set<string>();
        const deduped = merged.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
        setModels(deduped.length > 0 ? deduped : FALLBACK);
      })
      .catch(() => {
        if (!cancelled) setModels(FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, [open, models.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [models, query]);

  const selected = models.find((m) => m.id === currentModel) || models[0] || FALLBACK[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-gray-700 dark:text-gray-300">{selected.name}</span>
        <span className="text-xs text-gray-500"><span className="ms ms-sm">{open ? "keyboard_arrow_up" : "keyboard_arrow_down"}</span></span>
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 left-0 w-72 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
              setLimit((c) => Math.min(c + 50, Math.max(c, filtered.length)));
            }
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setLimit(50); }}
            placeholder="Search models…"
            className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent text-gray-700 dark:text-gray-300 outline-none sticky top-0 bg-white dark:bg-gray-800"
          />
          {filtered.slice(0, limit).map((model) => (
            <button
              key={model.id}
              onClick={() => { onModelChange(model.id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${
                model.id === currentModel ? "bg-orange-50 dark:bg-orange-900/20" : ""
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${model.id === currentModel ? "bg-orange-500" : "bg-gray-300"}`} />
              <div className="flex-1 text-left min-w-0">
                <div className="text-gray-700 dark:text-gray-300 truncate">{model.name}</div>
                <div className="text-xs text-gray-500 truncate">{model.provider}{model.detail ? ` · ${model.detail}` : ""}</div>
              </div>
            </button>
          ))}
          {filtered.length > limit && (
            <button
              onClick={() => setLimit((c) => c + 50)}
              className="w-full py-2 text-xs text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Show {Math.min(50, filtered.length - limit)} more…
            </button>
          )}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-xs text-gray-500">No models match “{query}”.</div>
          )}
        </div>
      )}
    </div>
  );
}

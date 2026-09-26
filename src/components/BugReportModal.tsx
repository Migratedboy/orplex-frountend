"use client";

import { useState, useEffect } from "react";
import { IconBug, IconClose, IconCheck } from "./Icons";
import { apiFetch } from "@/lib/api-base";

interface Props { onClose: () => void; }

export default function BugReportModal({ onClose }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), severity }),
      });
      const data = await res.json();
      setResult(data);
      if (data.success) setTimeout(onClose, 2000);
    } catch {
      setResult({ success: false, message: "Failed to send report." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Bug Report">
        <div className="modal-header">
          <div className="modal-header-left">
            <IconBug size={18} className="modal-header-icon" />
            <h2 className="modal-title">Bug Report</h2>
          </div>
          <button onClick={onClose} className="modal-close" aria-label="Close dialog"><IconClose size={16} /></button>
        </div>
        {result ? (
          <div className={`modal-result ${result.success ? "modal-result-success" : "modal-result-error"}`}>
            <div className="modal-result-icon">
              {result.success ? <IconCheck size={24} /> : <IconClose size={24} />}
            </div>
            <p className="modal-result-title">{result.success ? "Report Sent" : "Error"}</p>
            <p className="modal-result-msg">{result.message}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="modal-form">
            <div className="modal-field">
              <label className="settings-label">Title</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="settings-input" placeholder="Brief description of the issue…" required maxLength={200} />
            </div>
            <div className="modal-field">
              <label className="settings-label">Severity</label>
              <div className="modal-severity-group" role="radiogroup" aria-label="Severity level">
                {[
                  { value: "low", label: "Low", color: "#22c55e" },
                  { value: "medium", label: "Medium", color: "#eab308" },
                  { value: "high", label: "High", color: "#ef4444" },
                ].map(s => (
                  <button key={s.value} type="button" onClick={() => setSeverity(s.value)}
                    className={`modal-severity-btn ${severity === s.value ? "active" : ""}`}
                    style={severity === s.value ? { borderColor: s.color, color: s.color } : {}}
                    role="radio" aria-checked={severity === s.value}>
                    <span className="modal-severity-dot" style={{ background: s.color }} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-field">
              <label className="settings-label">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="settings-input settings-textarea" placeholder="Steps to reproduce, expected vs actual behavior…" required maxLength={5000} />
              <p className="settings-hint">{description.length}/5000</p>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onClose} className="modal-cancel-btn">Cancel</button>
              <button type="submit" disabled={loading || !title.trim() || !description.trim()} className="modal-submit-btn">
                {loading ? "Sending…" : "Submit Report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

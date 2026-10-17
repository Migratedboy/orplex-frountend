"use client";

import { IconClose, IconTrash } from "./Icons";

interface FilePreviewItem {
  name: string;
  content: string;
  size: number;
  type: string;
  dataUrl?: string;
}

interface Props {
  files: FilePreviewItem[];
  onRemove: (index: number) => void;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getFileExtLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ext.toUpperCase() || "?";
}

function getFileExtColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const colors: Record<string, string> = {
    ts: "#3178c6", tsx: "#3178c6", js: "#f7df1e", jsx: "#f7df1e",
    json: "#5f5e5e", py: "#3776ab", rb: "#cc342d", go: "#00add8",
    rs: "#dea584", java: "#ed8b00", html: "#e34c26", css: "#1572b6",
    scss: "#c6538c", md: "#5f5e5e", sql: "#e38c00", sh: "#4eaa25",
    yaml: "#cb171e", yml: "#cb171e", toml: "#9c4121", prisma: "#2d3748",
    png: "#a04100", jpg: "#a04100", jpeg: "#a04100", gif: "#a04100", webp: "#a04100",
  };
  return colors[ext] || "#5f5e5e";
}

export default function FilePreviewModal({ files, onRemove, onClose }: Props) {
  if (files.length === 0) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <h2 className="modal-title">{files.length} File(s) Ready</h2>
          </div>
          <button onClick={onClose} className="modal-close"><IconClose size={16} /></button>
        </div>
        <div className="file-preview-list">
          {files.map((f, i) => (
            <div key={i} className="file-preview-item">
              <div className="file-preview-ext" style={{ background: getFileExtColor(f.name) }}>
                {getFileExtLabel(f.name)}
              </div>
              <div className="file-preview-info">
                <div className="file-preview-name">{f.name}</div>
                <div className="file-preview-meta">
                  {formatSize(f.size)} &bull; {f.type === "image" ? "Image" : "Code/Text"}
                </div>
              </div>
              {f.type === "image" && f.dataUrl && (
                <div className="file-preview-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL; next/image has no data: source support */}
                  <img src={f.dataUrl} alt={f.name} />
                </div>
              )}
              {f.type === "text" && f.content && (
                <div className="file-preview-code">
                  <pre>{f.content.slice(0, 200)}{f.content.length > 200 ? "…" : ""}</pre>
                </div>
              )}
              <button onClick={() => onRemove(i)} className="file-preview-remove" title="Remove">
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button onClick={onClose} className="modal-submit-btn">Done</button>
        </div>
      </div>
    </div>
  );
}

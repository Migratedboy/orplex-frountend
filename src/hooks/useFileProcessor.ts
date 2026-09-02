"use client";

import { useState, useCallback } from "react";

export interface AttachedFile {
  name: string;
  content: string;
  size: number;
  type: string;
  dataUrl?: string;
}

export function useFileProcessor() {
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  const addFiles = useCallback((files: AttachedFile[]) => {
    setAttachedFiles((prev) => [...prev, ...files]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearFiles = useCallback(() => {
    setAttachedFiles([]);
  }, []);

  const getTextFiles = useCallback(() => {
    return attachedFiles.filter((f) => f.type === "text" && f.content);
  }, [attachedFiles]);

  const getImageFiles = useCallback(() => {
    return attachedFiles.filter((f) => f.type === "image" && f.dataUrl);
  }, [attachedFiles]);

  const formatContentWithFiles = useCallback((msg: string): string => {
    const textFiles = getTextFiles();
    if (textFiles.length === 0) return msg;

    const fileBlocks = textFiles.map((f) =>
      `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
    ).join("");
    return msg + fileBlocks;
  }, [getTextFiles]);

  return {
    attachedFiles,
    setAttachedFiles,
    addFiles,
    removeFile,
    clearFiles,
    getTextFiles,
    getImageFiles,
    formatContentWithFiles,
    hasFiles: attachedFiles.length > 0,
    fileCount: attachedFiles.length,
  };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    ts: "TS", tsx: "TSX", js: "JS", jsx: "JSX", json: "JSON",
    py: "PY", rb: "RB", go: "GO", rs: "RS", java: "JV",
    html: "HTML", css: "CSS", md: "MD", sql: "SQL",
    sh: "SH", yaml: "YML", yml: "YML", toml: "TOML",
    prisma: "PRM", graphql: "GQL",
    png: "IMG", jpg: "IMG", jpeg: "IMG", gif: "IMG", webp: "IMG",
  };
  return icons[ext] || ext.toUpperCase() || "FILE";
}

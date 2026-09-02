"use client";
import React, { useState } from "react";

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  status?: "created" | "creating" | "modified";
  size?: number;
}

interface FileTreeProps {
  files: FileNode[];
  onFileClick?: (path: string) => void;
}

function FileIcon({ node }: { node: FileNode }) {
  if (node.type === "directory") return <span className="text-orange-500">D</span>;
  const ext = node.name.split(".").pop() || "";
  const colors: Record<string, string> = {
    tsx: "text-blue-500", ts: "text-blue-400", jsx: "text-blue-500", js: "text-yellow-500",
    css: "text-purple-500", json: "text-green-500", md: "text-gray-500", html: "text-orange-400",
  };
  return <span className={colors[ext] || "text-gray-400"}>{ext.toUpperCase()}</span>;
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const styles: Record<string, string> = {
    created: "bg-green-100 text-green-700",
    creating: "bg-yellow-100 text-yellow-700 animate-pulse",
    modified: "bg-blue-100 text-blue-700",
  };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles[status] || ""}`}>{status}</span>;
}

function TreeNode({ node, depth, onFileClick }: { node: FileNode; depth: number; onFileClick?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.type === "directory") {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2 py-0.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="text-xs text-gray-400 w-3">{expanded ? "▼" : "▶"}</span>
          <FileIcon node={node} />
          <span className="text-gray-700 dark:text-gray-300">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileClick?.(node.path)}
      className="flex items-center gap-1.5 w-full px-2 py-0.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      <FileIcon node={node} />
      <span className="text-gray-700 dark:text-gray-300 flex-1 text-left">{node.name}</span>
      <StatusBadge status={node.status} />
    </button>
  );
}

export default function FileTree({ files, onFileClick }: FileTreeProps) {
  return (
    <div className="text-sm font-mono">
      {files.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} onFileClick={onFileClick} />
      ))}
    </div>
  );
}

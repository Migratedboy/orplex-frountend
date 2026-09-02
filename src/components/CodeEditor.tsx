"use client";

import { useState } from "react";
import Editor from "@monaco-editor/react";
import { useFileSystemContext } from "./FileSystemProvider";

type Tab = "code" | "preview" | "diff";

export default function CodeEditor() {
  const [activeTab, setActiveTab] = useState<Tab>("code");
  const { activeFilePath, fileContents, writeFile } = useFileSystemContext();

  const code = activeFilePath ? fileContents[activeFilePath] || "" : "";
  const language = activeFilePath ? getLanguageFromExtension(activeFilePath) : "plaintext";

  const handleEditorChange = (value: string | undefined) => {
    if (activeFilePath && value !== undefined) {
      writeFile(activeFilePath, value);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab Bar */}
      <div className="flex border-b border-border-glass bg-surface-container-lowest h-10 shrink-0">
        {[
          { id: "code" as Tab, label: "Code Editor", icon: "⟨/⟩" },
          { id: "preview" as Tab, label: "Live Preview", icon: "👁" },
          { id: "diff" as Tab, label: "Diff Viewer", icon: "±" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 flex items-center gap-2 border-r border-border-glass font-label text-[11px] transition-colors ${
              activeTab === tab.id
                ? "bg-surface-glass border-b-2 border-b-primary-container text-primary-container"
                : "hover:bg-surface-container-highest text-on-surface-variant"
            }`}
          >
            <span className="text-[16px]">{tab.icon}</span>
            [{tab.label}]
          </button>
        ))}
        <div className="flex-1 flex justify-end items-center px-2 gap-2">
          <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-wider">
            {activeFilePath || "No File Open"}
          </span>
        </div>
      </div>

      {/* Code View */}
      {activeTab === "code" && (
        <div className="flex-1 min-h-0 relative bg-[#1e1e1e]">
          {activeFilePath ? (
            <Editor
              height="100%"
              language={language}
              theme="vs-dark"
              value={code}
              onChange={handleEditorChange}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "JetBrains Mono, monospace",
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-on-surface-variant font-label text-[11px] bg-white dark:bg-zinc-950">
              Select a file from the Local Workspace tree to begin editing.
            </div>
          )}
        </div>
      )}

      {/* Preview Placeholder */}
      {activeTab === "preview" && (
        <div className="flex-1 flex items-center justify-center text-on-surface-variant font-label text-[11px]">
          <div className="text-center">
            <span className="text-4xl mb-4 block">👁</span>
            Live Preview — Build and run to see output
          </div>
        </div>
      )}

      {/* Diff Placeholder */}
      {activeTab === "diff" && (
        <div className="flex-1 flex items-center justify-center text-on-surface-variant font-label text-[11px]">
          <div className="text-center">
            <span className="text-4xl mb-4 block">±</span>
            Diff Viewer — No changes detected
          </div>
        </div>
      )}
    </div>
  );
}

function getLanguageFromExtension(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
      return "html";
    case "md":
      return "markdown";
    case "py":
      return "python";
    default:
      return "plaintext";
  }
}

"use client";

import { useState, useRef } from "react";
import FileUpload from "./FileUpload";
import ModeSelector, { AgentMode } from "./ModeSelector";
import { useFileProcessor, formatFileSize, getFileIcon } from "@/hooks/useFileProcessor";
import { IconDownload, IconStop, IconSend } from "./Icons";
import QuotaIndicator from "./QuotaIndicator";

interface ChatInputProps {
  onSend: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode) => void;
  onStop: () => void;
  loading: boolean;
  agentRunning: boolean;
  isStreaming?: boolean;
  agentMode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onFastAnswer?: (userMessage: string) => void;
  lastUserMessage?: string;
  queue?: { id: string; text: string; addedAt: number }[];
  onQueueAdd?: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
}

export default function ChatInput({ onSend, onStop, loading, agentRunning, isStreaming = false, agentMode, onModeChange, onFastAnswer, lastUserMessage, queue = [], onQueueAdd, onQueueRemove, onQueueClear }: ChatInputProps) {
  const [input, setInput] = useState("");
  const files = useFileProcessor();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = (text?: string) => {
    const msg = (text || input).trim();
    if (!msg && !files.hasFiles) return;

    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map(f => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));

    let contentWithFiles = msg;
    if (textFiles.length > 0) {
      const fileBlocks = textFiles.map((f) =>
        `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
      ).join("");
      contentWithFiles = msg + fileBlocks;
    }

    setInput("");
    files.clearFiles();
    onSend(msg, contentWithFiles, textFiles, imageFiles, agentMode);
  };

  const handleQueue = () => {
    const msg = input.trim();
    if (!msg && !files.hasFiles) return;
    if (!onQueueAdd) return;

    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map(f => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));

    let contentWithFiles = msg;
    if (textFiles.length > 0) {
      const fileBlocks = textFiles.map((f) =>
        `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
      ).join("");
      contentWithFiles = msg + fileBlocks;
    }

    setInput("");
    files.clearFiles();
    onQueueAdd(msg, contentWithFiles, textFiles, imageFiles, agentMode);
  };

  return (
    <div className="chat-input-bar">
      <div className="chat-input-inner">
        {files.hasFiles && (
          <div className="file-chips">
            {files.attachedFiles.map((f, i) => (
              <div key={i} className={`file-chip ${f.type === "image" ? "file-chip-image" : ""} ${f.name.startsWith("pasted-") ? "file-chip-pasted" : ""}`}>
                {f.type === "image" && f.dataUrl ? (
                  <img src={f.dataUrl} alt={f.name} className="file-chip-thumb" />
                ) : (
                  <span className="file-chip-icon">{getFileIcon(f.name)}</span>
                )}
                <div className="file-chip-info">
                  <span className="file-chip-name">{f.name}</span>
                  {f.name.startsWith("pasted-") && f.content ? (
                    <span className="file-chip-preview">{f.content.slice(0, 80)}{f.content.length > 80 ? "…" : ""}</span>
                  ) : (
                    <span className="file-chip-size">({formatFileSize(f.size)})</span>
                  )}
                </div>
                <button onClick={() => files.removeFile(i)} className="file-chip-remove">&times;</button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input-wrapper">
          <div className="chat-attach-btn-wrap">
            <FileUpload onFilesSelected={(newFiles) => files.addFiles(newFiles)} />
          </div>
          <ModeSelector mode={agentMode} onChange={onModeChange} />
          <textarea
            ref={textareaRef}
            className="chat-input-field"
            placeholder={agentMode === "code" ? "Describe what you want to build or fix…" : agentMode === "plan" ? "Ask me to analyze your codebase…" : "Message Orplex Agent…"}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            aria-label="Chat message"
          />
          <div className="chat-actions">
            {(loading || agentRunning) ? (
              <div className="chat-actions-active">
                <button onClick={onStop} className="chat-stop-btn" title="Stop (Esc)" aria-label="Stop generation">
                  <IconStop size={16} />
                </button>
                <button className="chat-queue-btn" title="Queue this prompt" aria-label="Queue next prompt" onClick={handleQueue}>
                  <span style={{ fontSize: 11, fontWeight: 600 }}>Q</span>
                </button>
              </div>
            ) : (
              <button onClick={() => handleSend()} disabled={!input.trim() && !files.hasFiles} className="chat-send-btn" aria-label="Send message">
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
        {queue.length > 0 && (
          <div className="queue-indicator">
            <div className="queue-header">
              <span className="queue-count">📋 Queue ({queue.length})</span>
              <button className="queue-clear-btn" onClick={onQueueClear}>Clear all</button>
            </div>
            <div className="queue-list">
              {queue.map((item, i) => (
                <div key={item.id} className="queue-item">
                  <span className="queue-item-drag" title="Drag to reorder">⋮⋮</span>
                  <span className="queue-item-num">{i + 1}</span>
                  <div className="queue-item-content">
                    <span className="queue-item-text">{item.text.slice(0, 60)}{item.text.length > 60 ? "…" : ""}</span>
                    <span className="queue-item-meta">
                      {item.text.length} chars • added {new Date(item.addedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <button className="queue-item-remove" onClick={() => onQueueRemove?.(item.id)} title="Remove from queue">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <QuotaIndicator />
        <p className="chat-disclaimer">Orplex Agent can make mistakes. Verify important information.</p>
        {onFastAnswer && lastUserMessage && isStreaming && (
          <div className="fast-answer-bar">
            <button
              className="fast-answer-btn"
              onClick={() => onFastAnswer(lastUserMessage)}
              title="Get a quick answer from a faster model"
            >
              <span>Answer Now</span>
              <span className="fast-answer-hint">— quick reply from a faster model</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

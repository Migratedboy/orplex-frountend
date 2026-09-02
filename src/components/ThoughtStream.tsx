"use client";

import { useState } from "react";
import { openArtifactPanel } from "./AppLayout";

type Tab = "thoughts" | "chat";

interface ChatMessage {
  role: "user" | "agent";
  agent?: string;
  text: string;
  time: string;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  { role: "user", text: "Refactor the authentication hook to use the new session provider.", time: "14:20" },
  { role: "agent", agent: "Architect-1", text: "Analyzing dependencies. I'll propose a plan before proceeding with the refactor.", time: "14:21" },
];

export default function ThoughtStream() {
  const [activeTab, setActiveTab] = useState<Tab>("thoughts");
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");

  const handleSend = async () => {
    if (!input.trim()) return;
    const userMsg: ChatMessage = { role: "user", text: input.trim(), time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Call AI API
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg].map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.text })) }),
      });
      const data = await res.json();
      const agentMsg: ChatMessage = { role: "agent", agent: "Coder-Alpha", text: data.reply || "I'm processing your request...", time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) };
      setMessages((prev) => [...prev, agentMsg]);
    } catch {
      const agentMsg: ChatMessage = { role: "agent", agent: "Coder-Alpha", text: "Connection error — AI service unavailable. Retrying...", time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) };
      setMessages((prev) => [...prev, agentMsg]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab Header */}
      <div className="p-4 border-b border-border-glass bg-surface-container-lowest flex items-center gap-2">
        <div className="flex gap-4 font-label text-[10px] uppercase tracking-[0.15em]">
          <button
            onClick={() => setActiveTab("thoughts")}
            className={`flex items-center gap-2 pb-2 transition-colors ${activeTab === "thoughts" ? "text-primary-container border-b-2 border-primary-container" : "text-on-surface-variant hover:text-primary-container"}`}
          >
            <span className="text-[10px] font-mono opacity-60">SYS</span> Thoughts
          </button>
          <button
            onClick={() => setActiveTab("chat")}
            className={`flex items-center gap-2 pb-2 transition-colors ${activeTab === "chat" ? "text-primary-container border-b-2 border-primary-container" : "text-on-surface-variant hover:text-primary-container"}`}
          >
            <span className="text-[11px] font-mono opacity-60">CHAT</span> Agent Chat
          </button>
        </div>
      </div>

      {/* Tool Chips */}
      <div className="p-2 border-b border-border-glass flex gap-2 flex-wrap bg-surface-dim">
        {["bash", "web_search", "fs_write"].map((tool) => (
          <span key={tool} className={`px-2 py-0.5 rounded-full border font-label text-[9px] flex items-center gap-1 ${tool === "fs_write" ? "border-primary-container/50 bg-primary-container/10 text-primary-container" : "border-border-glass bg-surface-glass text-on-surface-variant"}`}>
            {tool === "bash" ? "[SH]" : tool === "web_search" ? "[SRCH]" : "[ED]"} [{tool}]
          </span>
        ))}
      </div>

      {/* Content */}
      {activeTab === "thoughts" ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 font-code text-[11px]">
          {/* Architect Thought */}
          <div className="relative pl-4 border-l border-border-glass cursor-pointer hover:bg-surface-container-highest/30 rounded-r transition-colors" onClick={() => openArtifactPanel("latest")}>
            <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-soft-gold" />
            <div className="text-soft-gold font-bold mb-1">Architect-1</div>
            <div className="text-on-surface-variant mb-1">Analyzing system requirements for Dashboard component...</div>
            <div className="bg-surface p-2 rounded border border-border-glass text-outline font-label">
              Plan: Needs React hooks, framer-motion for animations. Delegating structural scaffolding to Coder-Alpha.
            </div>
          </div>

          {/* Coder Thought */}
          <div className="relative pl-4 border-l-2 border-primary-container pb-2 cursor-pointer hover:bg-surface-container-highest/30 rounded-r transition-colors" onClick={() => openArtifactPanel("latest")}>
            <div className="absolute -left-[6px] top-1 w-2.5 h-2.5 rounded-full bg-primary-container animate-pulse-amber" />
            <div className="text-primary-container font-bold mb-1 flex items-center gap-2">
              Coder-Alpha
              <span className="px-1 bg-primary-container/20 rounded text-[9px] uppercase tracking-wider">Active</span>
            </div>
            <div className="text-on-surface">Executing: <span className="text-primary-container bg-primary-container/10 px-1 rounded">[fs_write]</span> updating App.tsx</div>
            <div className="mt-2 text-outline-variant italic">Injecting useState and motion imports...</div>
          </div>

          {/* Sentinel Thought */}
          <div className="relative pl-4 border-l border-border-glass opacity-70">
            <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-emerald-500" />
            <div className="text-emerald-500 font-bold mb-1">Security-Sentinel</div>
            <div className="text-on-surface-variant">Waiting for code block completion to run static analysis.</div>
          </div>
        </div>
      ) : (
        <>
          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 font-body text-[13px]">
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <div className={`p-3 rounded-lg max-w-[90%] ${msg.role === "user" ? "bg-primary-container/10 border border-primary-container/30 text-primary-container rounded-tr-none" : "bg-on-tertiary-container/10 border border-on-tertiary-container/30 text-tertiary rounded-tl-none"}`}>
                  {msg.text}
                </div>
                <span className="text-[9px] text-outline mt-1 uppercase font-label tracking-wider">
                  {msg.role === "user" ? "User" : msg.agent} • {msg.time}
                </span>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="p-3 bg-surface-container-lowest border-t border-border-glass">
            <div className="relative flex items-center">
              <input
                className="w-full bg-obsidian border border-border-glass rounded px-3 py-2 text-[13px] focus:outline-none focus:border-primary-container/50 pr-20 transition-colors text-on-surface"
                placeholder="Message agents..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
              />
              <div className="absolute right-2 flex gap-1">
                <button className="text-on-surface-variant hover:text-primary-container text-[12px] font-mono">[+]</button>
                <button onClick={handleSend} className="text-primary-container text-[12px] font-mono hover:text-soft-gold transition-colors">{'[SEND]'}</button>
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <span className="text-[9px] text-on-surface-variant font-label flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container" /> Coder-Alpha
              </span>
              <span className="text-[9px] text-on-surface-variant font-label flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-soft-gold" /> Architect-1
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";

const INITIAL_LOGS = [
  { text: "orplex@tech:~/project$ npm run dev", color: "text-primary-container" },
  { text: "> orplex-tech@1.0.0 dev", color: "" },
  { text: "> next dev", color: "" },
  { text: "  ▲ Next.js 14.2.0", color: "" },
  { text: "  - Local:        http://localhost:3000/", color: "text-outline" },
  { text: "  - Network:      http://192.168.1.5:3000/", color: "text-outline" },
];

const SIMULATED_LOGS = [
  { text: "  ✓ Ready in 842ms", color: "text-emerald-400", delay: 1500 },
  { text: "  [Agent Swarm] Architect-1 initialized", color: "text-soft-gold", delay: 2200 },
  { text: "  [Agent Swarm] Coder-Alpha linked to index.tsx", color: "text-primary-container", delay: 2800 },
  { text: "  [Agent Swarm] Sec-Sentinel armed — scanning dependencies", color: "text-emerald-500", delay: 3500 },
];

export default function Terminal() {
  const [logs, setLogs] = useState(INITIAL_LOGS);
  const [collapsed, setCollapsed] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeouts: NodeJS.Timeout[] = [];
    SIMULATED_LOGS.forEach((log) => {
      const t = setTimeout(() => {
        setLogs((prev) => [...prev, { text: log.text, color: log.color }]);
      }, log.delay);
      timeouts.push(t);
    });
    return () => timeouts.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className={`${collapsed ? "h-10" : "h-48"} shrink-0 border-t border-border-glass bg-obsidian flex flex-col transition-[height]`}>
      {/* Terminal Header */}
      <div className="h-8 border-b border-border-glass flex items-center px-4 justify-between bg-surface-container-lowest shrink-0">
        <div className="font-label text-[10px] uppercase tracking-[0.15em] text-on-surface flex items-center gap-2">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Terminal
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-on-surface-variant cursor-pointer hover:text-white text-[14px]"
          >
            {collapsed ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Log Output */}
      {!collapsed && (
        <div className="flex-1 p-2 font-code text-[12px] text-on-surface-variant overflow-y-auto space-y-0.5">
          {logs.map((log, i) => (
            <div key={i} className={log.color}>{log.text}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

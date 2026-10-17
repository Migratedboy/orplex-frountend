"use client";

import { useEffect, useState } from "react";
import { useFileSystemContext } from "./FileSystemProvider";
import { OnboardingTour } from "./ui";

// FirstRunExperience.tsx — the empty-chat hero, Codex-style.
//
// Deliberately almost empty: centered logo, "Let's build with Orplex", and
// one quiet pill. The pill IS the first-run action — "Open folder" until a
// workspace is mapped, then it becomes the project chip. Advanced tools
// (Manager, browser, terminal) stay discoverable behind a muted toggle.
// The prompt bar, MCP controls, and the project control beside it are
// untouched — this component only owns the empty state above them.

const ADVANCED_ITEMS = [
  { id: "manager", icon: "dashboard", label: "Agent Manager", hint: "Run parallel agents on a board", href: "/manager" },
  { id: "preview", icon: "language", label: "Built-in browser", hint: "Real Chromium the agent can drive", panel: "preview" },
  { id: "terminal", icon: "terminal", label: "Terminal", hint: "A real shell in the sidebar", panel: "terminal" },
];

export default function FirstRunExperience() {
  const { directoryName, openFolder } = useFileSystemContext();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  // Ctrl+O opens the folder from the hero pill's keyboard hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFolder]);

  const hasWorkspace = Boolean(directoryName);

  return (
    <div className="empty-hero">
      <div className="empty-hero-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG logo: next/image cannot optimize SVG without dangerouslyAllowSVG, which Next.js advises against */}
        <img src="/logo.svg" alt="" aria-hidden="true" className="empty-hero-logo" width={44} height={44} />
        <h1 className="empty-hero-title">Let&apos;s build with Orplex</h1>

        <button
          className={`empty-hero-pill ${hasWorkspace ? "empty-hero-pill--project" : ""}`}
          onClick={() => { if (!hasWorkspace) void openFolder(); }}
          title={hasWorkspace ? `${directoryName} is mapped — the AI can read and edit it` : "Choose a project folder for the AI to work in"}
        >
          <span className="ms ms-sm">{hasWorkspace ? "folder_open" : "create_new_folder"}</span>
          <span className="empty-hero-pill-label">{hasWorkspace ? directoryName : "Open folder"}</span>
          {!hasWorkspace && <kbd className="empty-hero-kbd">Ctrl+O</kbd>}
        </button>

        <div className="empty-hero-advanced">
          <button className="empty-hero-advanced-toggle" onClick={() => setShowAdvanced(s => !s)}>
            <span className="ms ms-sm">{showAdvanced ? "expand_less" : "expand_more"}</span>
            {showAdvanced ? "Hide advanced tools" : "Explore the advanced tools"}
          </button>
          {showAdvanced && (
            <div className="empty-hero-advanced-grid">
              {ADVANCED_ITEMS.map(item => (
                <a
                  key={item.id}
                  className="empty-hero-advanced-item"
                  href={item.href}
                  onClick={(e) => {
                    if (item.panel) {
                      e.preventDefault();
                      window.dispatchEvent(new CustomEvent("orplex:open-panel", { detail: { tab: item.panel } }));
                    }
                  }}
                >
                  <span className="ms ms-sm">{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <em>{item.hint}</em>
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>

        <button className="empty-hero-advanced-toggle" onClick={() => setTourOpen(true)}>
          <span className="ms ms-sm">explore</span>
          Take the tour
        </button>
      </div>
      {tourOpen && (
        // Deferred close: the tour invokes onComplete from render once its
        // steps run out — a direct setState there would update this component
        // while the tour is still rendering.
        <OnboardingTour onComplete={() => setTimeout(() => setTourOpen(false), 0)} />
      )}
    </div>
  );
}

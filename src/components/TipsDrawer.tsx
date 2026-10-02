"use client";

import { useEffect, useState } from "react";

// TipsDrawer.tsx — one tip per session, bottom-right, self-dismissing.
//
// The persistent discoverability layer: every capability that hides behind a
// shortcut or a panel gets a tip here. One tip per app session (sessionStorage
// guard), rotated across sessions, dismissible, never modal, never blocking
// input. `orplex:next-tip` jumps to the next one immediately (used after the
// user finishes a related action, e.g. opening the palette).

interface Tip {
  id: string;
  icon: string;
  text: string;
  /** Optional action chip — dispatches a global event or navigates. */
  action?: { label: string; event?: string; href?: string };
}

const TIPS: Tip[] = [
  {
    id: "palette",
    icon: "keyboard_command_key",
    text: "Ctrl+K opens the command palette — every Orplex capability is one search away.",
  },
  {
    id: "starter",
    icon: "play_circle",
    text: "Not sure where to start? The chat home screen runs a starter task on your project in one click.",
  },
  {
    id: "right-panel",
    icon: "right_panel_open",
    text: "Ctrl+B opens the right panel; Ctrl+1…5 jumps straight to Queue, Changes, Files, Preview, or Terminal.",
    action: { label: "Try it", event: "orplex:demo-right-panel" },
  },
  {
    id: "agent-browser",
    icon: "web",
    text: "When the agent drives the built-in browser, the tab shows “agent is driving” — Take over anytime.",
  },
  {
    id: "health",
    icon: "monitor_heart",
    text: "The Manager board shows run health live: stuck runs, waiting approvals, and repair options.",
    action: { label: "Open board", href: "/manager" },
  },
  {
    id: "review-hunks",
    icon: "diff",
    text: "In Changes, expand a file to accept or reject individual hunks — review like a PR.",
  },
  {
    id: "tonight",
    icon: "dark_mode",
    text: "Spawn Agent offers “Tonight”: tasks queue for 02:00 and are done by morning.",
    action: { label: "Open board", href: "/manager" },
  },
  {
    id: "reset",
    icon: "restart_alt",
    text: "If anything ever looks frozen, Settings has a one-click “Reset agent state”.",
  },
];

const SESSION_KEY = "orplex.tipShown";
const INDEX_KEY = "orplex.tipIndex";
const DISMISS_KEY = "orplex.tipsOff";

export default function TipsDrawer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
      // One tip per session: sessionStorage is wiped when the app closes.
      if (sessionStorage.getItem(SESSION_KEY) === "1") return;
      const idx = Number(localStorage.getItem(INDEX_KEY) || "0") % TIPS.length;
      sessionStorage.setItem(SESSION_KEY, "1");
      localStorage.setItem(INDEX_KEY, String((idx + 1) % TIPS.length));
      setTip(TIPS[idx]);
    } catch {}
  }, []);

  useEffect(() => {
    if (!tip) return;
    const next = () => {
      const idx = Number(localStorage.getItem(INDEX_KEY) || "0") % TIPS.length;
      setTip(TIPS[idx]);
      localStorage.setItem(INDEX_KEY, String((idx + 1) % TIPS.length));
    };
    window.addEventListener("orplex:next-tip", next);
    return () => window.removeEventListener("orplex:next-tip", next);
  }, [tip]);

  if (!tip) return null;

  const runAction = () => {
    if (tip.action?.href) window.location.assign(tip.action.href);
    if (tip.action?.event) window.dispatchEvent(new CustomEvent(tip.action.event));
    setTip(null);
  };

  return (
    <div className="tips-drawer" role="status">
      <span className="tips-drawer-icon"><span className="ms ms-sm">tips_and_updates</span></span>
      <span className="tips-drawer-text">{tip.text}</span>
      {tip.action && (
        <button className="tips-drawer-action" onClick={runAction}>{tip.action.label}</button>
      )}
      <button className="tips-drawer-close" onClick={() => setTip(null)} aria-label="Dismiss tip">
        <span className="ms ms-sm">close</span>
      </button>
      <button
        className="tips-drawer-close tips-drawer-off"
        title="Stop showing tips"
        onClick={() => {
          try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
          setTip(null);
        }}
        aria-label="Turn off tips"
      >
        <span className="ms ms-sm">notifications_off</span>
      </button>
    </div>
  );
}

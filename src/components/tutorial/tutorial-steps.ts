"use client";

// tutorial-steps.ts — the single guided tour shown once, right after the
// account is created (first authenticated load of the app).
//
// Each step points at a REAL element of the UI, resolved live by a stable
// selector when the step is shown — never a captured node, so the step
// re-attaches itself if the panel it names re-mounts. A step without a
// `resolve` renders as a centered card (intro/outro). If a target can't be
// resolved within the tour's wait window, the tour skips to the next step.
//
// Selector rules that keep the tour honest:
//   • Only elements that exist on the chat start page ("/" — where the tour
//     fires). Collapsed branch children (e.g. Settings tabs) read as
//     zero-sized when hidden, which would stall the step for its whole wait
//     window — target the closed branch's header row instead.
//   • aria-labels, not visual text, when the control ships one.

export type TourPosition = "top" | "bottom" | "left" | "right";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Resolves the element to spotlight; absent = centered card. */
  resolve?: () => HTMLElement | null;
  /** Side of the target the tooltip prefers (auto-flips if it doesn't fit). */
  position?: TourPosition;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

export const TUTORIAL_STEPS: TourStep[] = [
  {
    id: "intro",
    title: "Welcome to Orplex Code",
    body: "Orplex is a coding agent that runs on your device: you describe a task, it plans, writes and verifies the change, and shows you everything it touched. This tour walks the interface once — every control it covers is real and clickable.",
  },
  {
    id: "prompt-bar",
    title: "Say what you want",
    body: "Type a request here and press Send. '@' mentions files and screenshots; '/' opens commands (skills, docs, tools); voice dictation is the mic button. Stop interrupts a running agent mid-step.",
    resolve: () => q("textarea.prompt-bar__input"),
    position: "top",
  },
  {
    id: "attach",
    title: "Add files and screenshots",
    body: "The + button attaches files and screenshot sources to your message, and attached files appear as chips above the composer (tap a chip's × to drop one). Everything the agent reads comes from YOUR machine.",
    resolve: () => q('[aria-label="Add files and sources"]'),
    position: "top",
  },
  {
    id: "mcp",
    title: "Plug tools in over MCP",
    body: "The MCP chip opens Connectors — a verified catalog of 100+ servers (GitHub, Vercel, Supabase, Figma…). Connect one, test it with a live tools/list, and the agent gains its tools; secrets are encrypted before storage and MCP calls surface in the tool chain for approval.",
    resolve: () => q('[aria-label="MCP connectors"]'),
    position: "top",
  },
  {
    id: "mode",
    title: "Pick how it works: Ask / Plan / Code",
    body: "Ask: conversation and explanations only, no file access. Plan: it reads and analyzes your workspace and writes out an exact plan. Code: the full agent — it edits files and runs commands on your device.",
    resolve: () => q('[aria-label="Choose mode"]'),
    position: "top",
  },
  {
    id: "model",
    title: "Choose the model",
    body: "Pick any model from connected providers — search the full catalogue, plus the recently used ones first. The green dot means a model was health-verified recently; a faded dot means re-verification is pending.",
    resolve: () => q('[aria-label="Choose model"]'),
    position: "bottom",
  },
  {
    id: "effort",
    title: "Set the effort level",
    body: "Effort controls how hard the agent works per run: how many rounds of planning, execution and self-verification it is allowed to spend. Higher effort = more thorough, more time.",
    resolve: () => q('[aria-label="Choose effort"]'),
    position: "bottom",
  },
  {
    id: "right-panel",
    title: "The agent's workbench",
    body: "The right panel docks everything the agent touches: Queue (pending prompts), Files (changes it makes), Preview (a real embedded browser it drives), and Terminal (its command output). Ctrl+B toggles it, Ctrl+T jumps to the terminal.",
    resolve: () => q('button[aria-label="Toggle right panel"]'),
    position: "bottom",
  },
  {
    id: "topbar-tools",
    title: "Search, fork, and manage",
    body: "In the bar above: search every conversation, fork the open chat into an independent copy, collapse the sidebar (Ctrl+\\), view notifications, switch dark/light, report a bug, and open all keyboard shortcuts with '?'.",
    resolve: () => q('[aria-label="Search conversations"]'),
    position: "bottom",
  },
  {
    id: "sidebar",
    title: "New Chat and History",
    body: "New Chat opens a blank thread instantly (Ctrl+N works too). History keeps every past thread — including workspace-less ones — searchable, and restores each chat with its files and context attached.",
    resolve: () => q('[data-tour-id="nav-new-chat"]'),
    position: "right",
  },
  {
    id: "agents",
    title: "Agents: Manager and Runs Board",
    body: "The Agents branch runs the heavy machinery. Agent Manager dispatches single-agent work and holds approval requests (the orange badge counts them). The Runs Board shows live multi-agent runs across your projects (the badge counts active runs).",
    resolve: () => q('[data-tour-id="nav-agents"]'),
    position: "right",
  },
  {
    id: "manager",
    title: "Agent Manager up close",
    body: "From here you launch agents with a chosen role, a workspace and an effort budget, then watch them work. When a run needs permission to act on your machine, the approval lands here and pings the badge.",
    resolve: () => q('[data-tour-id="nav-manager"]'),
    position: "right",
  },
  {
    id: "plugins",
    title: "Plugins extend the agent",
    body: "40 built-in bundles of skills, rules and hooks — quality, security, devops, domain, intelligence — install into this workspace with one click. You can also drop your own bundle folder (orplex-plugin.json) into .orplex/ and install that. Installed rules bind the agent.",
    resolve: () => q('[data-tour-id="nav-plugins"]'),
    position: "right",
  },
  {
    id: "playbook",
    title: "Playbook: your battle-tested advice",
    body: "Playbook grows from YOUR runs: lessons the agent learned get pinned as reusable guidance, ranked and decayed over time, and it borrows the right entry when a similar task appears again. It lives on this device as a plain file — no cloud copy.",
    resolve: () => q('[data-tour-id="nav-playbook"]'),
    position: "right",
  },
  {
    id: "settings",
    title: "Settings in one place",
    body: "The Settings branch covers: Profile (account + sessions), Appearance, Provider & Cost (models, usage, spend), API Keys (wire provider permissions), About, and Reset & Recovery for the dangerous buttons.",
    resolve: () => q('[data-tour-id="nav-settings"]'),
    position: "right",
  },
  {
    id: "projects",
    title: "Chats grouped by workspace",
    body: "Threads are grouped by the project folder they belong to. Click inside a project to reopen a workspace; right-click for reveal, rename or forget. A ghost chip means the thread is known but its folder isn't open on this device.",
    resolve: () => q(".conv-section-label"),
    position: "right",
  },
  {
    id: "user",
    title: "Your account",
    body: "Avatar, name and email at the foot of the rail; the exit icon signs you out. Storage is local-first: chats live on this device, and the cloud copy is a backup you can restore on any device.",
    resolve: () => q(".sidebar-user"),
    position: "right",
  },
  {
    id: "done",
    title: "That's every surface — go build",
    body: "Press '?' for the full shortcut list and Ctrl+K for the command palette. Missed a step? 'Take the tour' on the empty start screen replays this any time. Welcome aboard.",
  },
];

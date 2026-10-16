// contract/index.ts — The one import point for agent-loop shared logic.
//
/// Both execution modes (interactive client worker in background-worker.ts and
/// claimed server executor in server-executor/executor.ts) import tool-loop
/// shared logic from here. Nothing in this directory touches the filesystem,
/// the network, or the DOM — pure contract only. Backends (Electron IPC,
/// Playwright, git worktrees) plug in at the edges.
export * from "./loop";
export * from "./risk";
export * from "./scratchpad";
export * from "./results";
export * from "./tools";
export * from "./browser";

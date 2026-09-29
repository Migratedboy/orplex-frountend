// useProjects.ts — THE single owner of the Projects roster state.
//
// Owns: reading the registry, the cross-machine sync trigger (folder change +
// window focus + after any mutation), and every mutation (remember, forget +
// remote DELETE, alias, touch, path). Consumers (Sidebar et al.) never touch
// localStorage or the sync adapter directly — one piece of state, one writer.
//
// All mutations are optimistic (registry write → setState) with a
// fire-and-forget server sync so offline use never blocks the UI.

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  listProjectsLocal,
  rememberProject,
  touchProject,
  setProjectAlias,
  setProjectPath,
  forgetProject,
  deleteProjectHandle,
  type ProjectEntry,
} from "@/lib/project-registry";
import { syncNow, forgetProjectsRemote } from "@/lib/project-sync";

export interface UseProjects {
  /** Roster, most-recently-opened first (includes ghost rows). */
  projects: ProjectEntry[];
  /** Roster mutated + sync queued. */
  remember: (name: string, opts?: { displayName?: string; ghost?: boolean }) => void;
  /** Forget locally + delete the persisted handle + remote tombstone. */
  forget: (name: string) => void;
  /** Set/clear the display alias. */
  alias: (name: string, displayName: string | null) => void;
  /** Bump lastOpenedAt (activity ordering). */
  touch: (name: string) => void;
  /** Record the absolute folder path (Electron) for Reveal. */
  recordPath: (name: string, path: string) => void;
  /** Push/pull now (used on folder change/focus); merged roster applied. */
  sync: () => void;
}

export function useProjects(activeDirectoryName: string | null): UseProjects {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const dirNameRef = useRef(activeDirectoryName);
  dirNameRef.current = activeDirectoryName;

  const read = useCallback(() => setProjects(listProjectsLocal()), []);

  const sync = useCallback(() => {
    // Fire-and-forget, failure-tolerant: offline/unauthenticated keeps the
    // local roster. A merged roster (remote-only projects → ghosts) replaces
    // state so new machines' projects appear without a reload.
    syncNow(window.localStorage)
      .then((result) => {
        if (result.ok && result.projects) setProjects(result.projects);
      })
      .catch(() => {});
  }, []);

  // A sync-only project (opened on another device) exists in STATE but not in
  // localStorage — registry mutators scoped to known names (alias, touch) are
  // silent no-ops for it, so the mutation would vanish on the next read.
  // Materialize the entry into the roster first, preserving ghost state.
  const materialize = useCallback((name: string) => {
    const roster = listProjectsLocal();
    if (!roster.some((p) => p.name === name)) {
      const ghosted = projects.find((p) => p.name === name);
      rememberProject(window.localStorage, name, { ghost: ghosted?.ghost ?? false, displayName: ghosted?.displayName });
    }
  }, [projects]);

  // Sync trigger: folder change, window focus, and initial mount. Focus must
  // READ *and* RE-SYNC — a plain registry read would wipe ghost rows that
  // only exist in the sync-merged state (e.g. projects opened on another
  // device), so every click/focus would make server-known projects vanish.
  useEffect(() => {
    const refresh = () => {
      read();
      sync();
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [read, sync, activeDirectoryName]);

  const remember = useCallback(
    (name: string, opts?: { displayName?: string; ghost?: boolean }) => {
      rememberProject(window.localStorage, name, opts);
      read();
      sync();
    },
    [read, sync]
  );

  const forget = useCallback(
    (name: string) => {
      forgetProject(window.localStorage, name);
      deleteProjectHandle(name); // IndexedDB handle — best-effort, degrades off-browser
      forgetProjectsRemote([name]).catch(() => {}); // tombstone so sync can't resurrect
      read();
      sync();
    },
    [read, sync]
  );

  const alias = useCallback(
    (name: string, displayName: string | null) => {
      materialize(name);
      setProjectAlias(window.localStorage, name, displayName);
      read();
      sync();
    },
    [read, sync, materialize]
  );

  const touch = useCallback(
    (name: string) => {
      materialize(name);
      touchProject(window.localStorage, name);
      read();
      sync();
    },
    [read, sync, materialize]
  );

  const recordPath = useCallback(
    (name: string, path: string) => {
      setProjectPath(window.localStorage, name, path);
      read();
    },
    [read]
  );

  return { projects, remember, forget, alias, touch, recordPath, sync };
}

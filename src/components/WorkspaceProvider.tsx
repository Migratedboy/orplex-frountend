"use client";

// WorkspaceProvider — single owner of the Projects roster state.
//
// useProjects() must have exactly one instance: it owns registry reads, the
// cross-machine sync trigger, and every mutation. Both the sidebar's Projects
// section and the prompt bar's workspace switcher consume THIS context, so a
// mutation from either (remember/forget/alias/reopen) re-renders both and
// syncs once. Instantiated inside FileSystemProvider (needs directoryName to
// trigger re-syncs on folder change).

import React, { createContext, useContext } from "react";
import { useProjects, type UseProjects } from "@/hooks/useProjects";
import { useFileSystemContext } from "./FileSystemProvider";

const WorkspaceContext = createContext<UseProjects | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { directoryName } = useFileSystemContext();
  const projects = useProjects(directoryName);
  return <WorkspaceContext.Provider value={projects}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}

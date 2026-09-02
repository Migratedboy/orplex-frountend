"use client";

import React, { createContext, useContext } from "react";
import { useFileSystem } from "@/hooks/useFileSystem";
export type { FileNode } from "@/hooks/useFileSystem";

type FileSystemContextType = ReturnType<typeof useFileSystem>;

const FileSystemContext = createContext<FileSystemContextType | undefined>(undefined);

export function FileSystemProvider({ children }: { children: React.ReactNode }) {
  const fs = useFileSystem();
  return (
    <FileSystemContext.Provider value={fs}>
      {children}
    </FileSystemContext.Provider>
  );
}

export function useFileSystemContext() {
  const context = useContext(FileSystemContext);
  if (!context) {
    throw new Error("useFileSystemContext must be used within a FileSystemProvider");
  }
  return context;
}

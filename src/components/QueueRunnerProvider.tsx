"use client";

// QueueRunnerProvider — mounts the Manager queue-runner exactly once for the
// app. The queue-runner needs real file-system access (Manager-spawned tasks
// write to the user's workspace), which lives in useFileSystem. This provider
// bridges hook-land to the imperative runner; with no folder open it starts
// anyway and tasks simply fail fast with a clear "no folder open" result from
// the tool layer.

import { useEffect } from "react";
import { useFileSystem } from "@/hooks/useFileSystem";
import { setQueueFileSystemAccess, startQueueRunner, stopQueueRunner } from "@/lib/queue-runner";

export function QueueRunnerProvider({ children }: { children: React.ReactNode }) {
  const fs = useFileSystem();

  useEffect(() => {
    setQueueFileSystemAccess({
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      editFile: fs.editFile,
      directoryName: fs.directoryName,
      fileTree: fs.fileTree,
      fileContents: fs.fileContents,
    });
    startQueueRunner();
    return () => stopQueueRunner();
  }, [fs.readFile, fs.writeFile, fs.editFile, fs.directoryName, fs.fileTree, fs.fileContents]);

  return <>{children}</>;
}

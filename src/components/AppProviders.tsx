"use client";

import { FileSystemProvider } from "./FileSystemProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import HunkDecisionProvider from "./HunkDecisionProvider";
import { ConversationProvider } from "./ConversationProvider";
import { QueueRunnerProvider } from "./QueueRunnerProvider";

/**
 * Combines all app-level context providers into a single component.
 * This flattens the provider nesting in layout.tsx from 5 layers to 2.
 * QueueRunnerProvider sits inside FileSystemProvider because it bridges the
 * real FS hook into the Manager queue-runner (needs FS context).
 */
export default function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <FileSystemProvider>
      <WorkspaceProvider>
        <HunkDecisionProvider>
          <ConversationProvider>
            <QueueRunnerProvider>{children}</QueueRunnerProvider>
          </ConversationProvider>
        </HunkDecisionProvider>
      </WorkspaceProvider>
    </FileSystemProvider>
  );
}

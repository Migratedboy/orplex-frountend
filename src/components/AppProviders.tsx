"use client";

import { FileSystemProvider } from "./FileSystemProvider";
import HunkDecisionProvider from "./HunkDecisionProvider";
import { ConversationProvider } from "./ConversationProvider";

/**
 * Combines all app-level context providers into a single component.
 * This flattens the provider nesting in layout.tsx from 5 layers to 2.
 */
export default function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <FileSystemProvider>
      <HunkDecisionProvider>
        <ConversationProvider>
          {children}
        </ConversationProvider>
      </HunkDecisionProvider>
    </FileSystemProvider>
  );
}

"use client";

import { useHunkDecisions } from "@/hooks/useHunkDecisions";

/**
 * Thin wrapper that mounts the useHunkDecisions hook so that
 * window.applyHunkDecisions is available for the RightPanel's DiffView.
 */
export default function HunkDecisionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useHunkDecisions();
  return <>{children}</>;
}

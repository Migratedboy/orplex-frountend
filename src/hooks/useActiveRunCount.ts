"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-base";

/**
 * Polls /api/agent/runs?status=active for the count of in-progress runs.
 * Used by the sidebar for progressive disclosure: the Runs Board nav item
 * only shows its badge once the user has 2+ concurrent runs — before that
 * the single-run chat view is enough.
 */
export function useActiveRunCount(pollMs = 10000): {
  activeRuns: number;
  pendingApprovals: number;
} {
  const [activeRuns, setActiveRuns] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    let alive = true;
    const fetchActive = async () => {
      try {
        const res = await apiFetch("/api/agent/runs?status=active&limit=50");
        const data = await res.json();
        if (alive && data.success) {
          setActiveRuns(data.summary?.active ?? 0);
          setPendingApprovals(data.summary?.pendingApprovals ?? 0);
        }
      } catch {}
    };
    fetchActive();
    const interval = setInterval(fetchActive, pollMs);
    return () => { alive = false; clearInterval(interval); };
  }, [pollMs]);

  return { activeRuns, pendingApprovals };
}

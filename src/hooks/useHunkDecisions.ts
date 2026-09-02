"use client";

import { useEffect, useCallback } from "react";
import { useFileSystemContext } from "@/components/FileSystemProvider";
import { getPreviousContent } from "@/lib/file-history";

/**
 * Hook that exposes `applyHunkDecisions` on `window` so the RightPanel's
 * DiffView can trigger immediate file rollback when hunks are rejected.
 *
 * When any hunk is rejected, the file is immediately reverted to its
 * pre-change state using the file-history module.
 */
export function useHunkDecisions() {
  const { writeFile, readFile } = useFileSystemContext();

  const applyHunkDecisions = useCallback(
    async (
      filePath: string,
      _filteredDiff: string,
      _acceptedIds: number[],
      rejectedIds: number[]
    ) => {
      // If any hunks were rejected, immediately rollback the file
      if (rejectedIds.length > 0) {
        const prevContent = getPreviousContent(filePath);
        if (prevContent !== null) {
          const success = await writeFile(filePath, prevContent);
          if (success) {
            console.log(
              `[ROLLBACK] Reverted ${filePath} — ${rejectedIds.length} hunk(s) rejected`
            );
          } else {
            console.error(`[ROLLBACK] Failed to revert ${filePath}`);
          }
        } else {
          // New file with no previous content — delete isn't possible via FS API,
          // so we write empty content as a fallback
          console.warn(
            `[ROLLBACK] No previous content for ${filePath} — writing empty file`
          );
          await writeFile(filePath, "");
        }
      } else {
        // All hunks accepted — apply the filtered diff
        // The filtered diff already only contains accepted hunks
        console.log(
          `[APPLY] Applied filtered diff to ${filePath} — ${_acceptedIds.length} hunk(s) accepted`
        );
      }
    },
    [writeFile, readFile]
  );

  // Expose on window for RightPanel's DiffView callback
  useEffect(() => {
    (window as any).applyHunkDecisions = applyHunkDecisions;
    return () => {
      delete (window as any).applyHunkDecisions;
    };
  }, [applyHunkDecisions]);
}

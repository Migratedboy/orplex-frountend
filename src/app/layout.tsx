import type { Metadata } from "next";
import Providers from "@/components/Providers";

// Start backend-owned services on server startup (lazy-loaded to avoid
// blocking). These moved here during the physical split: the frontend no
// longer starts cron jobs, error tracking, backups or graceful shutdown —
// this app owns the database and all processing.
if (typeof window === "undefined") {
  import("@/lib/cron-reset").then(m => m.startDailyResetCron()).catch(() => {});
  import("@/lib/graceful-shutdown").then(m => m.startGracefulShutdown()).catch(() => {});
  import("@/lib/error-tracking").then(m => m.initErrorTracking()).catch(() => {});
  import("@/lib/backup").then(m => m.startBackupCron()).catch(() => {});
}

export const metadata: Metadata = {
  title: "Orplex Backend",
  description: "Orplex API server (API-only).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

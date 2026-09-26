import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import Providers from "@/components/Providers";
import BootGate from "@/components/loader/BootGate";
import AppLayout from "@/components/AppLayout";
import AppProviders from "@/components/AppProviders";
import ThemeInit from "@/components/ThemeInit";

// Start daily reset cron on server startup (lazy-loaded to avoid blocking)
if (typeof window === "undefined") {
  import("@/lib/cron-reset").then(m => m.startDailyResetCron()).catch(() => {});
  import("@/lib/graceful-shutdown").then(m => m.startGracefulShutdown()).catch(() => {});
  import("@/lib/error-tracking").then(m => m.initErrorTracking()).catch(() => {});
  import("@/lib/backup").then(m => m.startBackupCron()).catch(() => {});
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Orplex Tech",
    template: "%s | Orplex Tech",
  },
  description: "AI coding assistant with streaming chat, conversation history, file context, and multi-provider inference.",
  keywords: ["AI", "coding", "IDE", "agentic", "code generation", "debugging"],
  authors: [{ name: "Orplex Tech" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Orplex Tech",
    title: "Orplex Tech - AI Coding Assistant",
    description: "AI coding assistant with streaming chat, conversation history, and file context.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <ThemeInit />
        <Providers>
          <BootGate>
            <AppProviders>
              <AppLayout>{children}</AppLayout>
            </AppProviders>
          </BootGate>
        </Providers>
      </body>
    </html>
  );
}

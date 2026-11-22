import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import "../components/activity/activity.css";
import Providers from "@/components/Providers";
import BootGate from "@/components/loader/BootGate";
import AppLayout from "@/components/AppLayout";
import AppProviders from "@/components/AppProviders";
import ThemeInit from "@/components/ThemeInit";
import { THEME_BOOTSTRAP } from "@/lib/theme-bootstrap";

// Start app-level services on server startup (lazy-loaded to avoid blocking).
// Physical split: cron jobs, graceful shutdown, error tracking and backups are
// backend responsibilities — the frontend renders UI only, so those imports
// live in backend/src/app/layout.tsx. The frontend keeps its own boot hooks.

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Orplex Code",
    template: "%s | Orplex Code",
  },
  description: "AI coding assistant with streaming chat, conversation history, file context, and multi-provider inference.",
  keywords: ["AI", "coding", "IDE", "agentic", "code generation", "debugging"],
  authors: [{ name: "Orplex Code" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Orplex Code",
    title: "Orplex Code - AI Coding Assistant",
    description: "AI coding assistant with streaming chat, conversation history, and file context.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Resolve the stored theme before the first paint — see
            src/lib/theme-bootstrap.ts. Without this the light theme flashes
            the dark shell for a frame after hydration. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
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

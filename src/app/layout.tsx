import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./fonts.css";
import "./globals.css";
import "../components/activity/activity.css";
import Providers from "@/components/Providers";
import BootGate from "@/components/loader/BootGate";
import AppLayout from "@/components/AppLayout";
import AppProviders from "@/components/AppProviders";
import ThemeInit from "@/components/ThemeInit";
import { THEME_COOKIE, resolveTheme, themeAttributes } from "@/lib/theme-bootstrap";

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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved here, not by a script: the theme cookie is written by the theme
  // provider, so the first byte of HTML already carries the right data-theme
  // and the shell never paints the wrong colours for a frame.
  const store = await cookies();
  const theme = resolveTheme(store.get(THEME_COOKIE)?.value);
  const themeAttrs = themeAttributes(theme);

  return (
    <html lang="en" suppressHydrationWarning {...themeAttrs}>
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

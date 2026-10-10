"use client";

import { useEffect } from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "./ThemeProvider";
import { ToastProvider } from "./Toast";
import { initErrorTracking } from "@/lib/error-tracking";

export default function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initErrorTracking();
  }, []);
  return (
    <SessionProvider>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}

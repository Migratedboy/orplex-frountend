"use client";

import { useEffect } from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "./ThemeProvider";
import { ToastProvider } from "./Toast";
import { initErrorTracking } from "@/lib/error-tracking";
import AuthProvider from "./AuthProvider";

export default function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initErrorTracking();
  }, []);
  return (
    <AuthProvider>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

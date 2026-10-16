"use client";

import { SessionProvider } from "next-auth/react";

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  // refetchOnWindowFocus defaults to TRUE. next-auth returns a NEW session
  // object identity even when the data is unchanged, so every tab switch or
  // app focus re-rendered SessionProvider's context value, re-ran the
  // conversation-load effect in useConversation, and that effect REPLACES the
  // whole message array. Focusing the window mid-run therefore wiped the
  // in-flight turn - the question, the placeholder and all streamed output -
  // because that turn is not in the database yet. The write-back then could
  // not find its bubble and the answer was never rendered. Losing an in-flight
  // answer to a window blur is far worse than a session refetch being a few
  // seconds stale, so focus refetching is off; the normal session lifetime and
  // the signed-out handling in src/proxy.ts still apply.
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      {children}
    </SessionProvider>
  );
}

"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

// OfflineBanner.tsx — the friendly face of "no internet".
//
// When the network drops, next-auth's session poll fails and (before the
// proxy fix) surfaced as a raw CLIENT_FETCH_ERROR. The proxy now returns
// parseable JSON, and this banner translates connectivity loss into one
// honest sentence with a Retry. It listens to the browser's online/offline
// events so it disappears the moment the network returns.

export default function OfflineBanner() {
  const { status } = useSession();
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Session fetch failed but the browser still thinks it's online — the
  // cloud itself is unreachable (or auth is broken). Only treat auth errors
  // as "offline" while unauthenticated; a signed-in user with a network
  // blip shouldn't be told they're offline.
  useEffect(() => {
    if (status === "unauthenticated" && navigator.onLine) {
      // Verify once against a reliable endpoint before claiming offline.
      let alive = true;
      fetch("https://www.google.com/generate_204", { mode: "no-cors", signal: AbortSignal.timeout(5000) })
        .then(() => {
          if (alive) setOffline(false); // internet fine — it's an auth issue, not connectivity
        })
        .catch(() => {
          if (alive) setOffline(true);
        });
      return () => {
        alive = false;
      };
    }
  }, [status]);

  const retry = async () => {
    setChecking(true);
    try {
      await fetch("https://www.google.com/generate_204", { mode: "no-cors", signal: AbortSignal.timeout(5000) });
      window.location.reload();
    } catch {
      setChecking(false);
    }
  };

  if (!offline) return null;

  return (
    <div className="offline-banner" role="alert">
      <span className="offline-banner-icon"><span className="ms ms-sm">wifi_off</span></span>
      <span className="offline-banner-text">
        <strong>No internet connection.</strong> Orplex needs the internet to reach its cloud — sign-in, chat, and agent runs won&apos;t work until you reconnect.
      </span>
      <button className="offline-banner-btn" onClick={retry} disabled={checking}>
        {checking ? "Checking…" : "Retry"}
      </button>
    </div>
  );
}

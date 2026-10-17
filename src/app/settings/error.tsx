"use client";

import { useRouter } from "next/navigation";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  return (
    <div className="app-root">
      <div className="main-content">
        <div className="page-content">
          <div className="error-page">
            <div className="error-page-card">
              <div className="error-page-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ba1a1a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h1 className="error-page-title">Settings Error</h1>
              <p className="error-page-message">{error.message || "Failed to load settings."}</p>
              <button onClick={reset} className="error-page-retry">
                Try again
              </button>
              <button onClick={() => router.push("/")} className="error-page-home">
                Go to Home
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

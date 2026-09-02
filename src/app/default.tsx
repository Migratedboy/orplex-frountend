// default.tsx — Fallback for parallel routes
// Renders when the parallel route slot has no matching UI

import Link from "next/link";

export default function Default() {
  return (
    <div className="app-root">
      <div className="error-page">
        <div className="error-page-card">
          <h1 className="error-page-title">Welcome to Orplex</h1>
          <p className="error-page-message">Select a conversation or start a new chat.</p>
          <Link href="/" className="error-page-retry" style={{ textDecoration: "none" }}>
            Start New Chat
          </Link>
        </div>
      </div>
    </div>
  );
}

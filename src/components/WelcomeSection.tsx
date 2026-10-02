// Server Component — no "use client", no hooks, no interactivity
// This is static content that renders at build time

const SUGGESTIONS = [
  "Refactor the authentication hook to use the new session provider",
  "Generate a REST API for user management with CRUD operations",
  "Debug the memory leak in the canvas component",
  "Write unit tests for the data pipeline module",
];

export default function WelcomeSection() {
  return (
    <div className="welcome-container">
      <div className="welcome-inner">
        <img src="/logo.svg" alt="Orplex Code" className="welcome-logo" width={80} height={80} />
        <h1 className="welcome-heading">What can I help you build?</h1>
        <p className="welcome-subtext">Your agentic coding assistant. Ask me to write, debug, refactor, or architect code.</p>
        <div className="shortcut-hints">
          <span><kbd>Ctrl</kbd>+<kbd>K</kbd> Search</span>
          <span className="shortcut-sep">/</span>
          <span><kbd>Ctrl</kbd>+<kbd>N</kbd> New Chat</span>
          <span className="shortcut-sep">/</span>
          <span><kbd>Esc</kbd> Stop</span>
          <span className="shortcut-sep">/</span>
          <span><kbd>Ctrl</kbd>+<kbd>V</kbd> Paste Image</span>
        </div>
      </div>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((s, i) => (
          <button key={i} className="suggestion-card">
            <p className="suggestion-text">{s}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

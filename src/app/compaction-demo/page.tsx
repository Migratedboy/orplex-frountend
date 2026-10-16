"use client";

// A live preview of ContextCompactedDivider. Client because the demo needs
// local state for the action toasts — the component under test is
// self-contained and has no such requirement.
import { useState } from "react";
import ContextCompactedDivider from "@/components/ContextCompactedDivider";

const SHORT = `Earlier turns were summarized. The user asked for a "Context compacted" divider; I read the timeline renderer, added the AgentEvent variant and the token formatter, and wired the emission at the compaction call site. Key facts: dark theme only, no accent colour, collapsed by default.`;

const LONG = `This is the long-summary case, used to prove the expanded panel scrolls instead of growing without bound.

Earlier context that was evicted from the live transcript:
- The user opened with an environment report: PowerShell 5.1 on win32, so heredocs and several escape sequences behave differently than in bash. Bash-style \`<<'EOF'\` and \`&&\` chains must be avoided, and file writes should go through the Write tool rather than shell redirection.
- The app is Next.js 16 with Turbopack, React 18, and Electron 41. The desktop shell spawns Next as a child process; packaged builds run \`.next/standalone/server.js\` rather than \`next start\`.
- The user is impatient and wants working software, not plans. Several earlier attempts were abandoned mid-build; the standing preference is to finish a build and report honestly rather than narrate.
- Repeated preference: keep the SOURCE copy separate from build output, and do not delete working code — wire it up instead.
- Deployment: the API backend lives in a separate repository deployed to Vercel; the desktop app talks to it over ORPLEX_API_URL.

The point of this fixture is that a real compaction summary is often several paragraphs long, and the divider must cap it at 240px with its own scrollbar rather than pushing the rest of the timeline off screen. Scroll inside the panel to see the remainder of this text.

Extra filler so the scroll is unmistakable: alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu. Alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu. Alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.`;

export default function CompactionDemoPage() {
  const [toast, setToast] = useState<string | null>(null);
  const [undoed, setUndone] = useState(false);

  return (
    <div className="ccd-demo">
      <header className="ccd-demo-head">
        <h1>Context compacted</h1>
        <p>
          System-event marker for the agent timeline. Every tone is an existing
          token; the dark fill uses <code>--well</code>. No accent colour anywhere.
        </p>
      </header>

      <section>
        <h2>1 · Collapsed (default)</h2>
        <p className="ccd-demo-note">Nothing is expanded until you ask for it.</p>
        <ContextCompactedDivider tokensBefore={210_000} tokensAfter={22_000} mode="automatic" summary={SHORT} />
      </section>

      <section>
        <h2>2 · Expanded</h2>
        <p className="ccd-demo-note">Click the row. Long content scrolls inside a 240px cap.</p>
        <ContextCompactedDivider
          tokensBefore={210_000}
          tokensAfter={22_000}
          mode="automatic"
          summary={LONG}
          onCopy={(s) => setToast(`Copied ${s.length} chars`)}
          onViewFull={() => setToast("View full summary")}
        />
      </section>

      <section>
        <h2>3 · Manual mode</h2>
        <p className="ccd-demo-note">A user-initiated compaction reads differently from an automatic one.</p>
        <ContextCompactedDivider tokensBefore={98_400} tokensAfter={12_800} mode="manual" summary="User asked to compact: kept the failing test output and the two files under edit; dropped the exploratory reads." />
      </section>

      <section>
        <h2>4 · 1.2M tokens</h2>
        <p className="ccd-demo-note">Millions format to one decimal; the delta still stays compact.</p>
        <ContextCompactedDivider tokensBefore={1_200_000} tokensAfter={96_000} mode="automatic" summary="A very long session was compacted." />
      </section>

      <section>
        <h2>5 · No summary captured</h2>
        <p className="ccd-demo-note">Compaction can fall back to truncation; say so instead of showing nothing.</p>
        <ContextCompactedDivider tokensBefore={64_000} tokensAfter={16_000} mode="automatic" />
      </section>

      <section>
        <h2>6 · Kebab menu + undo</h2>
        <p className="ccd-demo-note">
          The kebab never toggles the row. With <code>onUndo</code> supplied, &ldquo;Undo compaction&rdquo;
          appears — the chat surface has no undo path today, so the live timeline omits it.
        </p>
        <ContextCompactedDivider
          tokensBefore={210_000}
          tokensAfter={22_000}
          mode="automatic"
          summary={SHORT}
          onCopy={(s) => setToast(`Copied ${s.length} chars`)}
          onViewFull={() => setToast("View full summary")}
          onUndo={() => {
            setUndone(true);
            setToast("Undo requested");
          }}
        />
        {undoed && <p className="ccd-demo-toast">onUndo fired — a real implementation would restore the evicted turns.</p>}
      </section>

      {toast && (
        <div className="ccd-demo-toast" role="status">
          {toast}
          <button onClick={() => setToast(null)}>dismiss</button>
        </div>
      )}
    </div>
  );
}
"use client";

import { useEffect, useState } from "react";

// WhatIsNew.tsx — the "What's new" modal.
//
// Two triggers:
//   1. After an update: the Electron main process records the last-run
//      version (orplex.lastVersion) and fires `orplex:whats-new` with the
//      version it upgraded to; the modal auto-opens once per version.
//   2. Any time from the Help menu / palette via `orplex:whats-new`.
//
// Changelog lives in code (WHATS_NEW) so shipping notes is a one-file diff —
// no backend round-trip, works offline, matches the installer's content.

export const WHATS_NEW: Record<string, { title: string; items: string[] }> = {
  "1.0.11": {
    title: "Desktop sign-in that actually works",
    items: [
      "Google and GitHub sign-in no longer stall on “Taking you to …”",
      "You stay signed in after the browser hand-off — no bounce back to the login screen",
      "A second sign-in attempt works instead of failing with “Sign-in could not start”",
      "Sign-in codes are stateless (HMAC + AES-GCM), so nothing is lost between server instances",
    ],
  },
  "1.0.12": {
    title: "The right notes for this build",
    items: [
      "Sign-in with Google or GitHub no longer stalls or bounces you back to the login screen",
      "“What’s new” now lists what THIS version changed instead of the same old notes",
      "Each release gets its own notes — the newest one you have installed wins",
    ],
  },
  "1.0.13": {
    title: "Release notes that match your build",
    items: [
      "“What’s new” shows what THIS version changed — no more copy-paste from another release",
      "Every build now picks the notes of the newest release it contains",
      "Desktop sign-in with Google and GitHub keeps working after an update",
    ],
  },
  "1.0.14": {
    title: "The app updates itself",
    items: [
      "A newer version is found and downloaded in the background — no button to hunt for",
      "Orplex restarts into the new build by itself, so it simply replaces the old one",
      "Nothing to delete or reinstall: the update is applied over your install",
      "Restarts wait for your running agents to finish (or press “Later” to hold it)",
    ],
  },
  "1.0.15": {
    title: "The app starts again — and updates itself",
    items: [
      "Fixed: the app could show Server failed to start even though its server was running",
      "The internal server is now reached on the address it is actually bound to (127.0.0.1)",
      "A newer version is found on your device, downloaded in the background and installed by itself",
      "The new build takes the place of the old one — nothing to delete or reinstall",
    ],
  },
  "1.0.23": {
    title: "Plugins work, and the app remembers your folder",
    items: [
      "Fixed: the Plugins page came back empty — the plugin list and the 40 built-in bundles now load on your own machine instead of the cloud",
      "Your open folder is remembered across restarts, so the agent's terminal and the Plugins page keep working",
      "Installing a bundle writes its skills, rules and hooks straight into that folder — one click, ready to use",
      "Playbook keeps its learned lessons in a plain file on this device — no database, no cloud copy, survives restarts",
      "New: a guided tour walks you through the app once, and “Take the tour” replays it any time",
      "Fixed: the model picker listed one model twice and logged a console error — no more duplicate rows",
    ],
  },
  "1.0.22": {
    title: "The agent stops losing work and blocking itself",
    items: [
      "Fixed: harmless commands were refused — rm -rf ./dist, npm run format, git commit -m \"fix format handling\" and echo \"$(git rev-parse HEAD)\" now run normally",
      "Fixed: a tool call that lost its arguments was dropped in silence — the agent now sees that the call never ran and retries properly",
      "Fixed: tool arguments the model sent were sometimes discarded, so tools arrived empty",
      "Command output is now capped before it reaches the model — huge build logs no longer slow every later turn down",
      "The agent's command results always state the exit code, the error and whether it ran on your device",
      "Backend fixes: a temporary database hiccup no longer leaves code mode permanently broken, and one run is no longer handed to two tabs",
    ],
  },
  "1.0.21": {
    title: "The agent's commands now run on your device",
    items: [
      "Fixed: one-liners like wc -l and ls -la failed with exit 1 on Windows — commands were run through cmd.exe, which has no Unix tools",
      "Commands now run through Git Bash when Git for Windows is installed, with the classic tooling available again; cmd.exe remains the fallback",
    ],
  },
  "1.0.20": {
    title: "Code mode works again — prompts stay model-sized",
    items: [
      "Fixed: sending a prompt in code mode could fail with HTTP 500 — the workspace context pushed more text than some models accept",
      "The disk-driven context now travels with much smaller per-file windows (10 files, ~16K characters each) so every model gets a prompt that fits",
    ],
  },
  "1.0.19": {
    title: "Files stay on disk — loaded only when needed",
    items: [
      "The agent no longer packs the whole workspace into one message — it now reads the file tree, then opens just the most relevant files from disk",
      "Big projects no longer balloon memory or prompt size; oversized files are read as head windows, never fully materialized",
    ],
  },
  "1.0.18": {
    title: "No way around the sign-in screen",
    items: [
      "Fixed: Terms of Service and Privacy Policy open in your browser as a separate page — they can no longer swap out the sign-in screen",
      "The taskbar always shows the Orplex logo — the default Electron icon bug is gone for good, even if a dev run leaves junk behind",
    ],
  },
  "1.0.17": {
    title: "Back to the Orplex look",
    items: [
      "Fixed: the app icon sometimes showed as Electron's default logo — the Windows icon is rebuilt and intact",
      "Icon files are now protected from ever being corrupted again",
    ],
  },
  "1.0.16": {
    title: "Terms, privacy and a steadier start",
    items: [
      "The sign-in page now links the real Terms of Service and Privacy Policy",
      "Both documents are readable before you sign in — no dead placeholder links",
      "Fixed: the app no longer gives up on a slow start and shows Server failed to start",
    ],
  },
  "1.0.28": {
    title: "One agent on every lane — and it proves the work",
    items: [
      "Fixed: the Groq and NVIDIA lanes used to get a weaker prompt and a smaller toolset — the agent there could not run the sandbox or verify a page in a browser. Every provider now gets the same full prompt and the same tools",
      "New: when a provider refuses a request as too large, the app retries once with a lean prompt on its own — no more “send it again in a minute”",
      "New: Ask mode can now read your project — “summarize this project” is answered from your real files instead of being guessed, and it still cannot write anything",
      "Fixed: background runs now have the same tools as the chat — sandbox runs, real browser verification, a task plan, web search, atomic multi-file edits, undo and zip extraction",
      "Fixed: tool calls written in the native param-key/param-value format were dropped in silence — they now run, and the raw markup never shows up in your chat",
      "Fixed: a file download card now counts as delivered work — the agent no longer claims “no files created” while the file sits on your screen",
      "Fixed: the agent must actually run a check before saying it is done — tests, builds and browser verification are part of its instructions now, and web search uses one shared engine in every lane",
    ],
  },
  "1.0.29": {
    title: "Stronger insides, same app",
    items: [
      "Under the hood: the agent's engine was reorganized into focused, test-pinned modules — every behavior is guarded by regression tests, and all 2,337 of them stay green",
      "Fixed: a server that fails to start because of a file-system or npm-cache permission problem is no longer misreported as a port conflict",
    ],
  },
  "1.0.30": {
    title: "Audited end to end",
    items: [
      "Fixed: a run that crashed could stay stuck on “running” forever — it now ends with a clear failure message instead of vanishing",
      "Fixed: a malformed chat request returned a server error instead of a proper “bad request”",
      "Fixed: two people deciding on the same request at the same time could both win — the second decision is now rejected instead of overwriting the first",
      "Fixed: an approval nobody answered no longer stays open forever — it expires on its own",
      "Fixed: a visitor's IP address could inject markup into the bug-report email — it is escaped now",
      "Fixed: the taskbar could show the Electron logo instead of the Orplex logo — the junk shortcut that caused it is removed automatically",
      "Security: updated the web framework to close a critical remote-code-execution hole in image generation",
    ],
  },
  "1.0.31": {
    title: "A loader you can actually see",
    items: [
      "The chat now shows a 3x3 dot-grid loader under the last message while the agent works",
      "New: the dot grid also appears while the model is thinking — you always see that the run is still going",
      "The dot grid stands on its own during thinking, so it never repeats the Thinking label",
      "When the turn ends it turns into the result icon (done, failed, stopped) — no more spinning forever",
      "The loader respects your system's reduced-motion setting",
    ],
  },
  "1.1.0": {
    title: "Faster path to your first win",
    items: [
      "Starter tasks: open a folder, click one card, watch the agent work",
      "Run health strip — stuck runs and waiting approvals surface themselves",
      "Command palette now describes every capability (Ctrl+K)",
      "Errors now come with a fix, not just a stack trace",
    ],
  },
  "1.2.0": {
    title: "MCP OAuth everywhere, clean UI",
    items: [
      "MCP connectors now use real OAuth where vendors support it — click Connect, sign in with browser, done",
      "Figma, GitHub, GitLab, Airtable, Google Workspace and 20+ remote MCP servers are zero-config or need only a one-time vendor client ID",
      "Token UI is removed for OAuth providers — no more false token fields for Figma / GitHub",
      "Thought / tool list no longer uses backdrop blur — light mode matches dark mode and the list is crisp",
      "Catalog audit passes: 32/32 remote endpoints verified, catalog version bumped to 1.2.0",
    ],
  },
  "1.2.1": {
    title: "The agent verifies its work — even offline",
    items: [
      "Fixed: asking the agent to rate, review or analyze your project no longer turns quoted code into generated files — you get the answer, code and all",
      "Fixed: app verification runs on a dedicated port, so the agent verifies YOUR app — not the Orplex window it lives in",
      "Verification survives a database outage — a Postgres that is not running can no longer bury a working PASS/FAIL report under “harness failed”",
      "Verification runs, screenshots and timeline are mirrored to a local file on your device while the database is offline — nothing is lost",
      "Browser tools no longer get rate-blocked exactly when the database is down",
      "Light mode renders the thought / tool list exactly like dark mode — same glass, same contrast in both themes",
    ],
  },
  "1.2.2": {
    title: "No database? Everything still works",
    items: [
      "Your projects live in device-local files now — conversations, keys, runs and settings keep working with no database server at all",
      "A dead or missing database can no longer time out requests — every data call answers instantly from local storage",
      "Your email and sign-in stay safely in the cloud account store; playbook learnings sync to the cloud and keep a local copy offline",
      "Suggestion chips wait for the full AI answer before regenerating — no more half-formed suggestions mid-reply",
      "Faster AI responses: your own API keys are tried first and ranked by real speed, built-in keys are only the fallback",
      "New: a subtle wave animation shows while suggestion chips are being generated",
    ],
  },
  "1.2.8": {
    title: "Groq is gone — MiniMax is the default",
    items: [
      "One fewer provider to babysit: Groq is removed, OpenRouter and NVIDIA carry everything",
      "New default model: MiniMax M3.1 Flash (free, via NVIDIA) — opens every fresh chat",
      "Free Models Router is the fallback default when no model is picked — you are never surprise-charged",
      "Your conversations, memory and workspace learnings live locally and survive everything — cloud syncs only identity and the playbook",
      "Every local file keeps a backup copy, so a single bad file can never wipe your data",
      "Moved machines? Export your whole local database as one portable file and import it anywhere",
    ],
  },
  "1.2.9": {
    title: "Export/import fix — the Database tab talks to your device",
    items: [
      "Fixed: Export/Import no longer bounce to the cloud backend — they always run on your device and read your real local database",
      "The Settings Database tab now works identically offline and online",
    ],
  },
  "3.0.0": {
    title: "The tools moved into the SDK — plugins come from the marketplace",
    items: [
      "The AI tool layer is now a published package (@orplex/sdk 0.3.1) — the app is the shell around it, and nothing in the app can drift from the tools it calls",
      "Plugins, MCP servers and skills are no longer baked into the app: 241 of them (101 skills, 100 MCP servers, 40 marketing and engineering plugins) are fetched from the signed catalog and cached, so a fresh install gets the current set instead of whatever shipped months ago",
      "The catalog is Ed25519-signed and every item carries a sha256 — an unsigned or edited item is refused instead of quietly installed",
      "Bundles carry their hook rules with them: installing a bundle wires its pre- and post-tool checks in one click",
      "Fixed: tool hooks could never block anything on Windows — the command went through Node's quoting and failed with “'C:\\Program' is not recognized”. Version-control checks and guards now actually run",
    ],
  },
  "3.0.6": {
    title: "Pull from GitHub, signed in",
    items: [
      "Pull from GitHub is preconfigured: the app ships the Orplex GitHub App client id, so connecting a repository needs no setup on your side. Click Connect GitHub, type the short code at github.com/login/device, and the app lists every repository you can reach",
      "The GitHub token for that flow is stored only on your machine and is used for cloning. It is never sent to the Orplex cloud, and no personal access token has to live on disk",
      "Sign-in survives a backend key rotation. If the app cannot verify your session it now says which reason it is instead of silently showing the sign-in screen again",
    ],
  },
  "3.0.5": {
    title: "One settings screen, and every control in it works",
    items: [
      "The rebuilt settings screen was never actually loaded — the app kept showing the old one. Settings now has a single screen: General, Account, Appearance, Usage, Model Providers, Database, Skills, Permissions, Keyboard shortcuts, Archived, About and Reset & Recovery",
      "Removed switches that did nothing. \"Advanced Mode\", \"Auto-renew sessions\" and \"Include AGENTS.md\" wrote a value that no part of the app ever read, so they are gone rather than pretending to work",
      "Notification sounds is real: a short chime when a run finishes while the window is not focused, and silence when you are watching",
      "Auto-archive chats is real: pick 1, 7 or 30 days and untouched chats move to Archived as the app loads — previously the dropdown stored a value nobody used",
      "\"Report issue or feature\" now opens the report form. It sent an event nothing listened for, so the button did nothing at all",
      "Pull from GitHub now lists the repositories your GitHub account can reach — private and public, owner/collaborator/organisation — with a search box, and still accepts a URL, branch and token by hand. Private clones get a credential from the backend for that one repository instead of asking you for a personal access token",
      "Connect GitHub from the project picker or from Settings → Account no longer fails with \"This action with HTTP GET is not supported by NextAuth.js\" — both use the same sign-in path as the sign-in screen",
      "Signing in no longer bounces you straight back to the sign-in screen: the app re-reads the backend\u0027s current session key when its own copy is out of date, and tells you which key is wrong if it still cannot verify you",
      "GitHub repository access can now use a GitHub App with the device flow: the app shows a short code, you type it at github.com/login/device, and the token stays on your machine. No redirect, no browser round-trip that can land you back on the sign-in page",
      "The email row in Account is read-only with a note that your sign-in provider owns it, instead of an edit box whose Save silently changed nothing",
      "Permissions and the cost breakdown, which the old screen had, are back in the new one under their own tabs",
    ],
  },
  "3.0.4": {
    title: "Updates that actually take effect",
    items: [
      "Fixed: after an auto-update the window could still show the previous version's UI while the app reported the new version. The app now checks the build id of the server it connects to instead of just checking that something answers the port, so an old server left behind can no longer shadow the new one",
      "Fixed: the previous version's server was not always fully stopped before the installer replaced files, which is what left the old UI in place on Windows",
      "The renderer cache is cleared once per installed version, so a new build cannot silently reuse the previous build's cached chunks",
      "If a stale copy of Orplex Code really is holding the port, the app says so and exits instead of quietly running the old build",
    ],
  },
  "3.0.3": {
    title: "Only the tools you need, and servers that come back",
    items: [
      "MCP tools are now ranked per request. With several connectors connected you can expose a couple of hundred tools; the app loads the fifteen that match what you asked for and keeps the rest one search away, instead of spending the whole prompt budget on schemas",
      "Tool arguments are checked before the call leaves the app, so a mistyped argument is reported in the turn straight away rather than coming back from the server after a partial change",
      "Fixed: an MCP server that crashed stayed dead until you restarted the app. It now restarts itself, gives up honestly after repeated failures, and never burns a restart on a shutdown you asked for",
      "The marketplace index is now replay-safe: an old copy can no longer be served to pin you to content the publisher has withdrawn, indexes expire, and items are revoked by id",
      "Item digests are unambiguous, so two different bundle contents can no longer share one fingerprint",
    ],
  },
  "3.0.2": {
    title: "Marketplace tools can no longer read your secrets",
    items: [
      "Security: MCP servers downloaded from the marketplace were started with this app's entire environment — they could read your session secret and database URL. They now receive only the variables their own manifest declares, plus the bare OS baseline they need to run",
      "Fixed: quitting the app could leave a marketplace MCP server running in the background, because only the launcher process was killed and not the process it spawned. Shutdown now terminates the whole process tree and reports what it cleaned up",
      "MCP tool calls have configurable timeouts, and a failure now says what went wrong in plain language (timed out, crashed, needs re-authentication) instead of an opaque string",
      "Fixed: a fresh install could show an empty model picker entry for a model OpenRouter had retired; the default list tracks the live catalogue again",
      "Fixed: the test suite stopped dead when the Windows temp drive filled up, reporting fifteen red suites that never ran",
    ],
  },
  "3.0.1": {
    title: "The supplied icon pack, and a title bar you can grab",
    items: [
      "New: the app icon, taskbar, tray and installer art are the packaged Orplex mark, used exactly as designed — corners are genuinely transparent, so the taskbar no longer draws a black plate around it",
      "The tray icon is the small-size variant rather than a shrunken large one, so it reads at 16px",
      "Fixed: the window had no minimise, maximise or close at all — the buttons were mounted but the desktop bridge behind them was missing, so a frameless window had no way to quit",
      "Windows keeps its own copy of tray icons; the stale copy is now cleared on upgrade, so the notification area stops showing the previous art",
      "Dev builds get a new window identity whenever an icon changes — a cached taskbar bitmap can no longer hide the new logo",
    ],
  },
};

/** "1.0.9" < "1.0.10" < "1.1.0" — plain numeric segment compare. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The notes of the running version. When a build has no entry of its own,
 * fall back to the newest release that is NOT newer than it — never to a
 * release from a future line (that is what made every update show the same
 * unrelated notes).
 */
export function entryFor(current: string | null): { title: string; items: string[] } {
  const known = Object.keys(WHATS_NEW).sort(compareVersions);
  if (current && WHATS_NEW[current]) return WHATS_NEW[current];
  if (current) {
    const notNewer = known.filter((v) => compareVersions(v, current) <= 0);
    if (notNewer.length) return WHATS_NEW[notNewer[notNewer.length - 1]];
  }
  return WHATS_NEW[known[0]];
}

const EVENT = "orplex:whats-new";

/** Fire from anywhere (Help menu, palette, Electron after an update). */
export function openWhatIsNew(version?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { version } }));
}

export default function WhatIsNew() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    // Auto-open after an UPDATE: the packaged app reports its real version
    // via the desktop bridge. If it differs from the one we last showed the
    // changelog for, open once and remember. (Plain-browser/dev fallback:
    // the orplex.lastVersion key set by whatever shipped the update.)
    (async () => {
      try {
        const current = (await window.orplexDesktop?.getAppVersion?.()) || localStorage.getItem("orplex.lastVersion");
        if (!current) return;
        setCurrentVersion(current);
        const seen = localStorage.getItem("orplex.appVersion");
        if (seen && seen !== current) {
          setVersion(seen); // "updated from vX"
          setOpen(true);
        }
        localStorage.setItem("orplex.appVersion", current);
      } catch {}
    })();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { version?: string } | undefined;
      if (detail?.version) setCurrentVersion(detail.version);
      setOpen(true);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  if (!open) return null;
  const entry = entryFor(currentVersion);
  const seenKey = `orplex.whatsNewSeen.${currentVersion || "latest"}`;

  const dismiss = () => {
    try { localStorage.setItem(seenKey, "1"); } catch {}
    setOpen(false);
  };

  return (
    <div className="win-overlay" onClick={dismiss} role="dialog" aria-modal="true" aria-label="What's new">
      <div className="win-card" onClick={(e) => e.stopPropagation()}>
        <div className="win-header">
          <span className="ms ms-lg win-spark">auto_awesome</span>
          <div>
            <h3 className="win-title">What&apos;s new in Orplex</h3>
            {version && <p className="win-version">updated from v{version}</p>}
          </div>
          <button className="win-close" onClick={dismiss} aria-label="Close"><span className="ms">close</span></button>
        </div>
        <ul className="win-list">
          {entry.items.map((item, i) => (
            <li key={i} className="win-item">
              <span className="ms ms-sm win-check">check_circle</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="win-footer">
          <span className="win-hint">Tips appear one at a time at the bottom of the screen — press <kbd className="win-kbd">?</kbd> anytime.</span>
          <button className="win-btn" onClick={dismiss}>Got it</button>
        </div>
      </div>
    </div>
  );
}

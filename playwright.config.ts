import { defineConfig, devices } from "playwright/test";
import { spawnSync } from "child_process";

// E2E suite for the chat flow.
//
// Mock provider: /api/chat answers with a slow, deterministic fake stream
// (MOCK_AI / src/lib/mock-ai.ts) so tests never touch a real AI provider,
// burn quota, or depend on API keys. When a dedicated dev server is spawned
// below it gets MOCK_AI=1; when an already-running dev server is reused the
// suite injects the dev-only `x-mock-ai: 1` header per request instead.
//
// Auth: the dev-only session bypass (/api/dev/session) is enabled outside
// production, so tests log in as a fixed "Dev User" with no OAuth.
//
// Why reuse instead of always spawning: Next dev only permits ONE server per
// project directory. If you already have `npm run dev` on :5000, a second
// `next dev` cannot start — so the suite detects a live dev server (by
// probing its /api/dev/session bypass) and reuses it. On CI / fresh machines
// it spawns its own on :5100.
//
// Run:  npm run test:e2e            (or: npx playwright test)

const REUSE_PORT = 5000; // conventional local dev port
const SPAWN_PORT = 5100; // dedicated E2E dev server
const SPAWN_URL = `http://localhost:${SPAWN_PORT}`;

/** Probe a dev server's /api/dev/session and report whether it is a live,
 *  non-production Orplex dev server ({ enabled: true }). */
function probeDevServer(port: number): boolean {
  const url = `http://localhost:${port}/api/dev/session`;
  const script = [
    `const http=require('http');`,
    `const r=http.get('${url}',res=>{let b='';res.on('data',c=>b+=c);`,
    `res.on('end',()=>{try{const j=JSON.parse(b);process.exit(j&&j.enabled===true?0:1);}catch{process.exit(1);}});});`,
    `r.on('error',()=>process.exit(1));`,
    `r.setTimeout(1500,()=>{r.destroy();process.exit(1);});`,
  ].join("");
  const out = spawnSync(process.execPath, ["-e", script], { timeout: 4000, encoding: "utf8" });
  return out.status === 0;
}

// E2E_BASE_URL lets you point the suite at any manually-managed dev server.
const baseOverride = process.env.E2E_BASE_URL;
const reuseExisting = !baseOverride && probeDevServer(REUSE_PORT);
const target = baseOverride ? { baseURL: baseOverride } : reuseExisting
  ? { baseURL: `http://localhost:${REUSE_PORT}` }
  : { baseURL: SPAWN_URL };

export default defineConfig({
  testDir: "./e2e",
  // The suite shares one dev server and one dev-user DB record — serialize.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: target.baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: reuseExisting || baseOverride
    ? undefined
    : {
        // Only reachable when no dev server is already running in this dir.
        command: `npx next dev -p ${SPAWN_PORT}`,
        url: `${SPAWN_URL}/auth/signin`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        // Keyless mock provider + explicit dev-auth bypass. Merge is over the
        // current process env; the rest (NEXTAUTH_SECRET, DATABASE_URL, …) is
        // picked up by Next from .env at boot.
        env: { MOCK_AI: "1", DEV_AUTH_BYPASS: "1" },
      },
});

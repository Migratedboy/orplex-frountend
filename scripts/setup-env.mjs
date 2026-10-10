// setup-env.mjs — ONE-TIME secrets setup for Orplex. Single source of truth:
// .env.example defines every key; this script fills, validates, and ships them.
//
//   npm run setup                  create .env from .env.example (never overwrites
//                                  existing values; auto-generates secrets)
//   npm run setup -- --check       verify required vars (CI gate; checks process.env
//                                  first, falls back to .env file)
//   npm run setup -- --vercel      push .env values to Vercel production
//                                  (--vercel=preview for the preview env)
//   npm run setup -- --pull        pull Vercel env down into .env (Vercel stays
//                                  the vault; local file gets backed up first)
//                                  (--pull=production for the production env)
//
// Testability: ORPLEX_ENV_FILE overrides the .env path (tests use a temp file).
// Secrets are NEVER printed — logs show `set (hidden)` / `missing` only.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.ORPLEX_ENV_FILE || join(ROOT, ".env");
const EXAMPLE_FILE = join(ROOT, ".env.example");

// Keys this script auto-generates when blank. Format notes match .env.example.
const GENERATORS = {
  NEXTAUTH_SECRET: () => randomBytes(32).toString("base64"),
  ENCRYPTION_SECRET: () => randomBytes(32).toString("hex"),
  CRON_SECRET: () => randomBytes(24).toString("hex"),
  ORPLEX_MCP_TOKEN: () => randomBytes(24).toString("hex"),
  ORPLEX_SYNC_HUB_SECRET: () => randomBytes(24).toString("hex"),
};

// Required to boot (fail --check when missing).
const REQUIRED = ["DATABASE_URL", "DIRECT_URL", "NEXTAUTH_SECRET"];
// Required in real production (warn, don't fail — CI/dev don't need them).
const PROD_WARN = ["ENCRYPTION_SECRET"];
// At least one of these should exist (warn only).
const PROVIDER_KEYS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

// Values that must NEVER be pushed to Vercel (localhost/dev placeholders).
const LOCALHOST_RE = /localhost|127\.0\.0\.1|user:password|changeme|example\.com/i;
// Keys pushed by --vercel (everything else stays local-only).
const VERCEL_PUSH_KEYS = new Set([
  "NEXTAUTH_SECRET", "NEXTAUTH_URL", "DATABASE_URL", "DIRECT_URL", "ENCRYPTION_SECRET",
  "ADMIN_USER_IDS", "CRON_SECRET", "MIN_SUPPORTED_APP_VERSION",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "GROQ_API_KEY", "AI_PROVIDER",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "EMAIL_SERVER", "EMAIL_FROM", "SENTRY_DSN", "NEXT_PUBLIC_BUGSINK_DSN", "BUGSINK_DSN",
  "LOG_LEVEL", "E2B_API_KEY", "ORPLEX_SYNC_HUB_SECRET", "AGENT_EXEC_DISABLED",
  "ALLOWED_ORIGINS", "NEXT_PUBLIC_API_BASE_URL", "ORPLEX_API_URL", "AUTH_COOKIE_DOMAIN", "AUTH_COOKIE_SAMESITE",
]);

function parseEnvFile(path) {
  const map = new Map();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function exampleKeys() {
  // Only ACTIVE (uncommented) keys are spec — commented lines are opt-in docs.
  const keys = [];
  for (const line of readFileSync(EXAMPLE_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function isBlank(v) {
  return v === undefined || v === "";
}

function cmdSetup() {
  const existing = parseEnvFile(ENV_FILE);
  const keys = exampleKeys();
  let created = !existsSync(ENV_FILE);
  const lines = [];

  if (created) {
    // Fresh file: copy example structure, filling generated secrets.
    for (const line of readFileSync(EXAMPLE_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=\s*(.*)$/);
      if (m && isBlank(m[2]) && GENERATORS[m[1]]) {
        lines.push(`${m[1]}=${GENERATORS[m[1]]()}`);
      } else {
        lines.push(line);
      }
    }
    writeFileSync(ENV_FILE, lines.join("\n"), "utf8");
    console.log(`created ${ENV_FILE} (secrets generated, never printed)`);
  } else {
    // Existing file: append only AUTO-GENERATED secrets that are missing or
    // blank. Optional keys left blank on purpose are reported, never
    // duplicated. Nothing existing is ever overwritten.
    const missing = keys.filter((k) => isBlank(existing.get(k)));
    const generatable = missing.filter((k) => GENERATORS[k]);
    const optional = missing.filter((k) => !GENERATORS[k]);
    if (generatable.length > 0) {
      const additions = ["", "# --- added by npm run setup (missing secrets) ---"];
      for (const k of generatable) additions.push(`${k}=${GENERATORS[k]()}`);
      appendFileSync(ENV_FILE, additions.join("\n") + "\n", "utf8");
      console.log(`appended ${generatable.length} generated secret(s): ${generatable.join(", ")}`);
    } else {
      console.log(`${ENV_FILE} secrets complete — nothing changed`);
    }
    if (optional.length > 0) {
      console.log(`optional keys left blank (fill as needed): ${optional.join(", ")}`);
    }
  }
  return 0;
}

function effectiveEnv() {
  // process.env wins (CI, Vercel build), .env file fills the rest.
  return new Map([...parseEnvFile(ENV_FILE), ...Object.entries(process.env)]);
}

function cmdCheck() {
  const env = effectiveEnv();
  let failed = false;
  for (const k of REQUIRED) {
    if (isBlank(env.get(k))) {
      console.error(`missing required: ${k} — run: npm run setup`);
      failed = true;
    }
  }
  if (process.env.NODE_ENV === "production") {
    for (const k of PROD_WARN) {
      if (isBlank(env.get(k))) console.error(`missing production: ${k} — run: npm run setup`);
    }
  }
  if (!PROVIDER_KEYS.some((k) => !isBlank(env.get(k)))) {
    console.warn("warning: no AI provider key set (NVIDIA/GROQ/OpenRouter/OpenAI/Anthropic)");
  }
  if (!failed) console.log("env check passed");
  return failed ? 1 : 0;
}

function vercelAvailable() {
  const r = runVercel(["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}

// spawnSync can't execute Windows .ps1 shims directly — route through shell
// on win32. Every vercel invocation goes through here.
function runVercel(args, opts) {
  return spawnSync("vercel", args, {
    ...opts,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function cmdVercel(target) {
  if (!["production", "preview", "development"].includes(target)) {
    console.error(`bad target: ${target} (use production|preview|development)`);
    return 1;
  }
  if (!vercelAvailable()) {
    console.error("vercel CLI not found — install: npm i -g vercel && vercel login");
    return 1;
  }
  const env = parseEnvFile(ENV_FILE);
  let pushed = 0, skipped = 0, refused = 0;
  for (const key of VERCEL_PUSH_KEYS) {
    const value = env.get(key);
    if (isBlank(value)) {
      skipped++;
      continue;
    }
    if (LOCALHOST_RE.test(value)) {
      console.log(`refused (localhost placeholder): ${key}`);
      refused++;
      continue;
    }
    const r = runVercel(["env", "add", key, target], {
      input: value + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (r.status === 0) {
      pushed++;
      console.log(`pushed: ${key} → ${target}`);
    } else if (/already exists|already been/i.test(out)) {
      console.log(`exists (left untouched): ${key} → ${target}`);
      skipped++;
    } else {
      console.error(`failed: ${key} → ${target}: ${out.slice(0, 160)}`);
      refused++;
    }
  }
  console.log(`done: ${pushed} pushed, ${skipped} skipped, ${refused} refused/failed`);
  console.log("NOTE: preview env should use its own DATABASE_URL (never push prod DB to preview).");
  return refused > 0 ? 1 : 0;
}

function cmdPull(target) {
  if (!["production", "preview", "development"].includes(target)) {
    console.error(`bad target: ${target} (use production|preview|development)`);
    return 1;
  }
  if (!vercelAvailable()) {
    console.error("vercel CLI not found — install: npm i -g vercel && vercel login");
    return 1;
  }
  // Back up the local file first — pull overwrites, and local-only keys
  // (AGENT_EXEC_DISABLED, WORKSPACE_DIR, dev URLs) must survive.
  if (existsSync(ENV_FILE)) {
    const backup = `${ENV_FILE}.pre-pull-${Date.now()}`;
    try {
      writeFileSync(backup, readFileSync(ENV_FILE, "utf8"), "utf8");
      console.log(`backed up local .env → ${backup}`);
    } catch (err) {
      console.error(`backup failed, aborting pull: ${err.message}`);
      return 1;
    }
  }
  const r = runVercel(["env", "pull", ENV_FILE, "--environment", target, "--yes"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0) {
    console.error(`pull failed: ${out.slice(0, 300)}`);
    return 1;
  }
  // Report coverage by NAME only — values never touch the logs.
  const env = parseEnvFile(ENV_FILE);
  const present = REQUIRED.filter((k) => !isBlank(env.get(k)));
  const missing = REQUIRED.filter((k) => isBlank(env.get(k)));
  console.log(`pulled ${target} env into ${ENV_FILE}`);
  if (present.length) console.log(`present: ${present.join(", ")}`);
  if (missing.length) {
    console.error(`still missing: ${missing.join(", ")} — set them in Vercel dashboard, then pull again`);
    return 1;
  }
  return 0;
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  process.exit(cmdCheck());
}
const vercelArg = args.find((a) => a === "--vercel" || a.startsWith("--vercel="));
if (vercelArg) {
  const target = vercelArg.includes("=") ? vercelArg.split("=")[1] : "production";
  process.exit(cmdVercel(target));
}
const pullArg = args.find((a) => a === "--pull" || a.startsWith("--pull="));
if (pullArg) {
  const target = pullArg.includes("=") ? pullArg.split("=")[1] : "development";
  process.exit(cmdPull(target));
}
process.exit(cmdSetup());

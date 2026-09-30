// ci-sandbox.ts — GitHub Actions as the sandboxed execution backend.
//
// When local command execution is disabled (AGENT_EXEC_DISABLED=1 on hosted
// deployments), a configured CI sandbox keeps `run_command` useful WITHOUT
// ever touching the server's own filesystem: the command is dispatched to a
// locked-down GitHub Actions workflow (agent-sandbox.yml), executed on an
// ephemeral runner, and the stdout/stderr/exit-code come back as a workflow
// artifact.
//
// SERVER-ONLY: reads ORPLEX_CI_GITHUB_TOKEN / ORPLEX_CI_REPO from env. Never
// import from client components. Commands are screened by the same exec-guard
// the local path uses, so blocklist evasion is caught before dispatch.

import { randomUUID } from "crypto";
import { isCommandAllowed } from "@/lib/exec-guard";

const GITHUB_API = "https://api.github.com";
const DEFAULT_WORKFLOW = "agent-sandbox.yml";
const DEFAULT_REF = "main";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 4_000;

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  source: "ci-sandbox";
  /** GitHub run URL for audit/debug. */
  runUrl?: string;
}

/** True when the CI sandbox is fully configured (token + repo). */
export function isSandboxConfigured(): boolean {
  return Boolean(process.env.ORPLEX_CI_GITHUB_TOKEN && process.env.ORPLEX_CI_REPO);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orplex-ci-sandbox",
  };
}

interface GhWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
  html_url: string;
  created_at: string;
}

async function ghFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers || {}) },
  });
  return res;
}

/** Sleep helper. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `command` in the CI sandbox workflow and collect its output.
 * Correlation: the workflow's run-name embeds our random token
 * ("ci-sandbox <token>"), so polling can never pick up someone else's run.
 */
export async function dispatchSandbox(command: string, opts?: { timeoutMs?: number }): Promise<SandboxResult> {
  const token = process.env.ORPLEX_CI_GITHUB_TOKEN;
  const repo = process.env.ORPLEX_CI_REPO;
  if (!token || !repo) {
    return { stdout: "", stderr: "CI sandbox not configured (ORPLEX_CI_GITHUB_TOKEN / ORPLEX_CI_REPO)", exitCode: 1, source: "ci-sandbox" };
  }

  // Same screening as the local exec path — the sandbox is not an escape hatch.
  const guard = isCommandAllowed(command);
  if (!guard.allowed) {
    return { stdout: "", stderr: `BLOCKED: ${guard.reason}`, exitCode: 126, source: "ci-sandbox" };
  }

  const workflow = process.env.ORPLEX_CI_SANDBOX_WORKFLOW || DEFAULT_WORKFLOW;
  const ref = process.env.ORPLEX_CI_SANDBOX_REF || DEFAULT_REF;
  const timeoutMs = opts?.timeoutMs ?? (Number(process.env.ORPLEX_CI_SANDBOX_TIMEOUT_MS || 0) || DEFAULT_TIMEOUT_MS);
  const runToken = `sbx-${randomUUID().slice(0, 8)}`;
  const expectedTitle = `ci-sandbox ${runToken}`;

  // 1. Dispatch.
  const dispatchRes = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, token, {
    method: "POST",
    body: JSON.stringify({
      ref,
      inputs: {
        command: command.slice(0, 6000),
        run_token: runToken,
        ref,
      },
    }),
  }).catch((err) => null);
  if (!dispatchRes) {
    return { stdout: "", stderr: "CI sandbox dispatch failed (network error)", exitCode: 1, source: "ci-sandbox" };
  }
  if (dispatchRes.status !== 204) {
    const body = await dispatchRes.text().catch(() => "");
    return {
      stdout: "",
      stderr: `CI sandbox dispatch rejected: HTTP ${dispatchRes.status} ${body.slice(0, 300)}`,
      exitCode: 1,
      source: "ci-sandbox",
    };
  }

  // 2. Poll for OUR run (matched by display_title — race-free).
  const deadline = Date.now() + timeoutMs;
  let run: GhWorkflowRun | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const listRes = await ghFetch(
      `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=20&created=>${new Date(Date.now() - 10 * 60_000).toISOString()}`,
      token
    ).catch(() => null);
    if (!listRes?.ok) continue;
    const list = (await listRes.json().catch(() => null)) as { workflow_runs?: GhWorkflowRun[] } | null;
    const found = (list?.workflow_runs || []).find((r) => r.display_title === expectedTitle);
    if (found) {
      run = found;
      if (found.status === "completed") break;
    }
  }
  if (!run) {
    return { stdout: "", stderr: `CI sandbox run not found within ${Math.round(timeoutMs / 1000)}s`, exitCode: 1, source: "ci-sandbox" };
  }

  // 3. Wait for completion.
  while (run.status !== "completed" && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const runRes = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${run.id}`, token).catch(() => null);
    if (runRes?.ok) {
      const updated = (await runRes.json().catch(() => null)) as GhWorkflowRun | null;
      if (updated) run = { ...run, ...updated };
    }
  }
  if (run.status !== "completed") {
    return { stdout: "", stderr: "CI sandbox run timed out before completion", exitCode: 1, source: "ci-sandbox", runUrl: run.html_url };
  }

  // 4. Fetch the result artifact.
  const artRes = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${run.id}/artifacts`, token).catch(() => null);
  if (!artRes?.ok) {
    return { stdout: "", stderr: `CI sandbox run ${run.conclusion || "completed"} but artifacts unreachable`, exitCode: 1, source: "ci-sandbox", runUrl: run.html_url };
  }
  const artList = (await artRes.json().catch(() => null)) as {
    artifacts?: Array<{ id: number; name: string }>;
  } | null;
  const artifact = (artList?.artifacts || []).find((a) => a.name === "sandbox-result");
  if (!artifact) {
    return {
      stdout: "",
      stderr: `CI sandbox run ${run.conclusion || "completed"} without a sandbox-result artifact`,
      exitCode: 1,
      source: "ci-sandbox",
      runUrl: run.html_url,
    };
  }

  const zipRes = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/artifacts/${artifact.id}/zip`, token).catch(() => null);
  if (!zipRes?.ok) {
    return { stdout: "", stderr: "Failed to download sandbox artifact", exitCode: 1, source: "ci-sandbox", runUrl: run.html_url };
  }
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
  const stdout = (await zip.file("stdout.txt")?.async("string")) || "";
  const stderr = (await zip.file("stderr.txt")?.async("string")) || "";
  const exitRaw = (await zip.file("exit-code.txt")?.async("string")) || "";
  const exitCode = Number.parseInt(exitRaw.trim(), 10);
  return {
    stdout: stdout.slice(0, 100_000),
    stderr: stderr.slice(0, 100_000),
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    source: "ci-sandbox",
    runUrl: run.html_url,
  };
}

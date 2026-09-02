import chalk from "chalk";

interface DoctorOptions {
  url: string;
  apiKey?: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log(chalk.bold("\n🔍 Orplex Doctor\n"));
  const checks: CheckResult[] = [];

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    name: "Node.js version",
    ok: major >= 18,
    detail: `${nodeVersion} ${major >= 18 ? "(OK)" : "(requires 18+)"}`,
  });

  // 2. Server connectivity
  try {
    const res = await fetch(`${options.url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as Record<string, any>;
    checks.push({
      name: "Server reachable",
      ok: res.ok,
      detail: `${options.url} — ${data.status || res.status}`,
    });

    // 3. Database
    checks.push({
      name: "Database",
      ok: data.checks?.database === "ok",
      detail: data.checks?.database || "unknown",
    });

    // 4. Memory
    checks.push({
      name: "Memory",
      ok: true,
      detail: data.checks?.memory || "unknown",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "Server reachable",
      ok: false,
      detail: `${options.url} — ${msg}`,
    });
  }

  // 5. API key
  checks.push({
    name: "API key configured",
    ok: !!options.apiKey,
    detail: options.apiKey ? "Set" : "Not set (optional for local)",
  });

  // Print results
  for (const check of checks) {
    const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon}  ${chalk.bold(check.name)}: ${chalk.dim(check.detail)}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? chalk.green("\n✓ All checks passed!\n")
      : chalk.red(`\n✗ ${failed.length} check(s) failed\n`),
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

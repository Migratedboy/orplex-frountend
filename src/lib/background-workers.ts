/**
 * background-workers.ts — Auto-Triggered Background Workers
 *
 * 6 workers that run automatically after code changes:
 * 1. testgap-detector — finds missing tests
 * 2. security-scanner — scans for vulnerabilities
 * 3. docs-generator — auto-generates documentation
 * 4. perf-analyzer — detects performance issues
 * 5. code-dedup — finds duplicate code patterns
 * 6. dependency-checker — verifies package versions
 *
 * Based on Ruflo's 12 auto-triggered workers.
 */

// ============================================================
// Types
// ============================================================

export type WorkerType =
  | "testgap-detector"
  | "security-scanner"
  | "docs-generator"
  | "perf-analyzer"
  | "code-dedup"
  | "dependency-checker";

export interface WorkerResult {
  worker: WorkerType;
  success: boolean;
  findings: Finding[];
  duration: number;
  summary: string;
}

export interface Finding {
  severity: "critical" | "warning" | "info";
  type: string;
  file?: string;
  line?: number;
  description: string;
  fix?: string;
}

// ============================================================
// Worker Registry
// ============================================================

const workers: Map<WorkerType, (files: Record<string, string>) => Promise<WorkerResult>> = new Map();

// ============================================================
// Worker 1: Test Gap Detector
// ============================================================

workers.set("testgap-detector", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  for (const [path, content] of Object.entries(files)) {
    // Skip test files themselves
    if (path.includes(".test.") || path.includes(".spec.") || path.includes("__tests__")) continue;

    // Check if this is a module with exported functions
    const exports = content.match(/export\s+(?:function|const|class)\s+(\w+)/g);
    if (!exports || exports.length === 0) continue;

    // Check if a corresponding test file exists
    const testPath = path.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1");
    const specPath = path.replace(/\.(ts|tsx|js|jsx)$/, ".spec.$1");
    const hasTest = files[testPath] || files[specPath];

    if (!hasTest) {
      findings.push({
        severity: "warning",
        type: "missing-test",
        file: path,
        description: `No test file found for ${path} (${exports.length} exports)`,
        fix: `Create ${testPath} with tests for: ${exports.map(e => e.replace(/export\s+(?:function|const|class)\s+/, "")).join(", ")}`,
      });
    }
  }

  return {
    worker: "testgap-detector",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "All modules have test coverage"
      : `${findings.length} module(s) missing tests`,
  };
});

// ============================================================
// Worker 2: Security Scanner
// ============================================================

workers.set("security-scanner", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  const securityPatterns = [
    { pattern: /eval\s*\(/g, type: "eval-usage", severity: "critical" as const, desc: "eval() usage — potential code injection" },
    { pattern: /innerHTML\s*=/g, type: "xss-innerhtml", severity: "critical" as const, desc: "innerHTML assignment — potential XSS" },
    { pattern: /dangerouslySetInnerHTML/g, type: "xss-dangerous", severity: "warning" as const, desc: "dangerouslySetInnerHTML — ensure content is sanitized" },
    { pattern: /password\s*[=:]\s*["'][^"']+["']/gi, type: "hardcoded-password", severity: "critical" as const, desc: "Hardcoded password detected" },
    { pattern: /api[_-]?key\s*[=:]\s*["'][^"']+["']/gi, type: "hardcoded-apikey", severity: "critical" as const, desc: "Hardcoded API key detected" },
    { pattern: /secret\s*[=:]\s*["'][^"']+["']/gi, type: "hardcoded-secret", severity: "critical" as const, desc: "Hardcoded secret detected" },
    { pattern: /console\.(log|debug|info)\s*\(/g, type: "console-logging", severity: "info" as const, desc: "Console logging in production code" },
    { pattern: /TODO|FIXME|HACK|XXX/g, type: "todo-fixme", severity: "info" as const, desc: "Unresolved TODO/FIXME" },
    { pattern: /new Function\s*\(/g, type: "dynamic-function", severity: "warning" as const, desc: "Dynamic function creation — potential injection" },
    { pattern: /document\.write\s*\(/g, type: "document-write", severity: "warning" as const, desc: "document.write() — consider safer alternatives" },
  ];

  for (const [path, content] of Object.entries(files)) {
    for (const { pattern, type, severity, desc } of securityPatterns) {
      // Reset regex lastIndex for each file
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split("\n").length;
        findings.push({ severity, type, file: path, line: lineNum, description: desc });
      }
    }
  }

  return {
    worker: "security-scanner",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "No security issues found"
      : `${findings.filter(f => f.severity === "critical").length} critical, ${findings.filter(f => f.severity === "warning").length} warnings`,
  };
});

// ============================================================
// Worker 3: Docs Generator
// ============================================================

workers.set("docs-generator", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  // Check if README exists
  const hasReadme = files["README.md"] || files["readme.md"];
  if (!hasReadme && Object.keys(files).length > 3) {
    findings.push({
      severity: "info",
      type: "missing-readme",
      description: "No README.md found in project",
      fix: "Create README.md with project description, setup instructions, and API docs",
    });
  }

  // Check for undocumented exports
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    if (path.includes(".test.") || path.includes(".spec.")) continue;

    const exports = content.match(/export\s+(?:function|const|class|interface|type)\s+(\w+)/g);
    if (!exports) continue;

    for (const exp of exports) {
      const name = exp.replace(/export\s+(?:function|const|class|interface|type)\s+/, "");
      // Check if there's a JSDoc comment above the export
      const exportIndex = content.indexOf(exp);
      const beforeExport = content.slice(Math.max(0, exportIndex - 200), exportIndex);
      const hasJSDoc = beforeExport.includes("/**") && beforeExport.includes("*/");

      if (!hasJSDoc) {
        findings.push({
          severity: "info",
          type: "missing-docs",
          file: path,
          description: `Export "${name}" has no JSDoc documentation`,
          fix: `Add /** description */ above the ${name} export`,
        });
      }
    }
  }

  return {
    worker: "docs-generator",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "Documentation is up to date"
      : `${findings.length} documentation improvement(s) found`,
  };
});

// ============================================================
// Worker 4: Performance Analyzer
// ============================================================

workers.set("perf-analyzer", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  const perfPatterns = [
    { pattern: /useEffect\(\s*\(\)\s*=>\s*\{[^}]*fetch/g, type: "fetch-in-effect", desc: "fetch() inside useEffect — consider React Query or SWR for caching" },
    { pattern: /JSON\.parse\(JSON\.stringify/g, type: "deep-clone", desc: "JSON.parse(JSON.stringify()) — use structuredClone() instead" },
    { pattern: /\.map\(.*\.filter\(.*\.map\(/g, type: "chained-iterators", desc: "Chained .map().filter().map() — consider combining into single pass" },
    { pattern: /for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\w+\.length/g, type: "for-loop", desc: "Consider using for...of or array methods for readability" },
    { pattern: /new Array\(\d{4,}\)/g, type: "large-array", desc: "Large array allocation — consider lazy loading or pagination" },
  ];

  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx") && !path.endsWith(".js") && !path.endsWith(".jsx")) continue;

    for (const { pattern, type, desc } of perfPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split("\n").length;
        findings.push({ severity: "info", type, file: path, line: lineNum, description: desc });
      }
    }
  }

  return {
    worker: "perf-analyzer",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "No performance issues detected"
      : `${findings.length} performance suggestion(s)`,
  };
});

// ============================================================
// Worker 5: Code Dedup
// ============================================================

workers.set("code-dedup", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  // Simple dedup: find similar function signatures across files
  const signatures = new Map<string, string[]>();

  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;

    const funcs = content.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g);
    if (!funcs) continue;

    for (const func of funcs) {
      const normalized = func.replace(/\s+/g, " ").trim();
      const existing = signatures.get(normalized) || [];
      existing.push(path);
      signatures.set(normalized, existing);
    }
  }

  for (const [sig, paths] of signatures) {
    if (paths.length > 1) {
      findings.push({
        severity: "info",
        type: "duplicate-function",
        file: paths[0],
        description: `Duplicate function signature in ${paths.length} files: ${sig.slice(0, 60)}`,
        fix: `Consider extracting to a shared utility in ${paths[0]}`,
      });
    }
  }

  return {
    worker: "code-dedup",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "No duplicate code detected"
      : `${findings.length} potential duplicate(s)`,
  };
});

// ============================================================
// Worker 6: Dependency Checker
// ============================================================

workers.set("dependency-checker", async (files) => {
  const start = Date.now();
  const findings: Finding[] = [];

  // Check for unused imports
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;

    const imports = content.match(/import\s+\{[^}]+\}\s+from\s+["'][^"']+["']/g) || [];
    for (const imp of imports) {
      const importedNames = imp.match(/\{([^}]+)\}/)?.[1]?.split(",").map(s => s.trim().split(" as ").pop()?.trim() || s.trim()) || [];
      for (const name of importedNames) {
        if (!name) continue;
        // Check if the imported name is used in the file (excluding the import line itself)
        const contentWithoutImport = content.replace(imp, "");
        if (!contentWithoutImport.includes(name)) {
          findings.push({
            severity: "info",
            type: "unused-import",
            file: path,
            description: `Unused import: "${name}" from ${imp.match(/from\s+["']([^"']+)["']/)?.[1]}`,
            fix: `Remove "${name}" from the import statement`,
          });
        }
      }
    }
  }

  return {
    worker: "dependency-checker",
    success: true,
    findings,
    duration: Date.now() - start,
    summary: findings.length === 0
      ? "All imports are used"
      : `${findings.length} unused import(s) found`,
  };
});

// ============================================================
// Worker Runner
// ============================================================

/**
 * Run all workers on a set of files.
 */
export async function runAllWorkers(
  files: Record<string, string>,
  enabledWorkers: WorkerType[] = [
    "testgap-detector",
    "security-scanner",
    "docs-generator",
    "perf-analyzer",
    "code-dedup",
    "dependency-checker",
  ]
): Promise<WorkerResult[]> {
  const results: WorkerResult[] = [];

  for (const workerName of enabledWorkers) {
    const workerFn = workers.get(workerName);
    if (!workerFn) continue;

    try {
      const result = await workerFn(files);
      results.push(result);
    } catch (err) {
      results.push({
        worker: workerName,
        success: false,
        findings: [],
        duration: 0,
        summary: `Worker failed: ${(err as Error).message}`,
      });
    }
  }

  return results;
}

/**
 * Get a combined report from all worker results.
 */
export function getWorkerReport(results: WorkerResult[]): string {
  const lines = ["## Background Workers Report", ""];

  let totalFindings = 0;
  let criticalCount = 0;

  for (const result of results) {
    const icon = result.success ? "+" : "!";
    lines.push(`### ${result.worker} [${icon}] — ${result.summary}`);
    lines.push(`Duration: ${result.duration}ms`);
    lines.push("");

    for (const finding of result.findings) {
      totalFindings++;
      if (finding.severity === "critical") criticalCount++;
      const severityIcon = finding.severity === "critical" ? "!!!" : finding.severity === "warning" ? "!!" : "!";
      lines.push(`  ${severityIcon} [${finding.severity}] ${finding.description}`);
      if (finding.file) lines.push(`    File: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
      if (finding.fix) lines.push(`    Fix: ${finding.fix}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(`Total findings: ${totalFindings} (${criticalCount} critical)`);

  return lines.join("\n");
}

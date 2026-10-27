// context-builder.ts — disk-driven workspace context packaging
//
// The AI pulls what it needs from DISK on demand. Nothing here reads whole
// files into a resident map: each candidate is read once, head-only (bounded
// window), and dropped after the prompt text is composed. The file tree
// (names only, already cheap) plus targeted head-of-file windows replaces the
// old strategy of "small repo → include EVERY file's full content", which
// loaded whole workspaces into RAM and blew up prompt size on medium repos.

interface ContextResult {
  context: string;
  includedFiles: number;
  totalFiles: number;
  estimatedTokens: number;
}

/** Read one workspace file from disk. Return null when unreadable. */
export type DiskRead = (path: string) => Promise<string | null>;

// Lightweight token estimator (4 chars ≈ 1 token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Build file tree string
function buildFileTreeString(nodes: any[], depth = 0): string {
  return nodes.map((node: any) => {
    const pad = "  ".repeat(depth);
    if (node.kind === "directory") {
      const children = buildFileTreeString(node.children || [], depth + 1);
      return `${pad}${node.name}/\n${children}`;
    }
    return `${pad}${node.name}`;
  }).join("\n");
}

// Check if message is a simple greeting
const SIMPLE_PATTERNS = /^(hi|hello|hey|thanks|thank you|ok|yes|no|help|bye|sup|yo|hola|howdy|cool|nice|great|awesome|perfect)/i;

// Bounded per-file window: a candidate's head is enough for scoring plus a
// useful snippet. Oversized files stay on disk — read_file/search_code reach
// the rest on demand.
const HEAD_LINES = 350;
const HEAD_CHARS = 60_000;

// Prompt budget (chars). ~160K tokens of context copies — way under any model
// window and orders of magnitude smaller than the old full-dump path.
const CONTEXT_CAP_CHARS = 640_000;

// How many distinct files may contribute content to one prompt.
const MAX_FILES = 28;

// Number of candidates actively read from disk for scoring.
const MAX_CANDIDATE_READS = 60;

/** Detect task type from user message for smarter file prioritization */
function detectTaskType(message: string): string {
  const lower = message.toLowerCase();
  if (/fix|bug|error|broken|crash|fail/.test(lower)) return "bugfix";
  if (/add|create|implement|build|new|feature/.test(lower)) return "feature";
  if (/refactor|reorganize|clean|restructure|rename/.test(lower)) return "refactor";
  if (/test|spec|coverage/.test(lower)) return "testing";
  if (/style|css|design|ui|layout|theme/.test(lower)) return "styling";
  if (/performance|speed|optimize|fast|slow/.test(lower)) return "performance";
  if (/security|auth|login|permission/.test(lower)) return "security";
  if (/deploy|build|ci|cd|pipeline/.test(lower)) return "devops";
  return "general";
}

/** Flatten a FileNode tree to workspace-relative file paths. */
function flattenFilePaths(nodes: any[]): string[] {
  const out: string[] = [];
  const walk = (ns: any[]) => {
    for (const n of ns) {
      if (n.kind === "file") out.push(n.path);
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function truncateHead(text: string): string {
  if (text.length <= HEAD_CHARS) return text;
  const lines: string[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    // one megalong line must not blow the window
    if (total + line.length > HEAD_CHARS) break;
    lines.push(line);
    total += line.length;
    if (lines.length >= HEAD_LINES) break;
  }
  return lines.length > 0 ? lines.join("\n") : text.slice(0, HEAD_CHARS);
}

/**
 * Compose the workspace context from DISK reads.
 * - Paths are pre-scored from the tree (path keywords, entry points, source
 *   extensions, task type) — zero filesystem access.
 * - Only the top candidates get exactly one head-read each; each is used for
 *   scoring (keyword hits, signature lines) and, if strong enough, included.
 * - The typed user request is the LAST segment after `User request: `.
 */
export async function buildDiskContext(
  fileTree: any[],
  readFile: DiskRead | null,
  userMessage: string,
  directoryName: string
): Promise<ContextResult> {
  const trimmed = userMessage.trim().toLowerCase();
  if (!readFile || (trimmed.length < 20 && SIMPLE_PATTERNS.test(trimmed))) {
    return { context: userMessage, includedFiles: 0, totalFiles: 0, estimatedTokens: estimateTokens(userMessage) };
  }

  const allPaths = flattenFilePaths(fileTree);
  const keywords = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 15);
  const taskType = detectTaskType(userMessage);

  // Pass 1 — score paths WITHOUT reading anything.
  const scored = allPaths.map((path) => {
    const pathLower = path.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (pathLower.includes(kw)) score += 20;
    if (/\.(ts|tsx|js|jsx)$/.test(path) && !path.includes(".test.")) score += 3;
    if (path.includes("index.") || path.includes("page.") || path.includes("layout.")) score += 5;
    if (/\.test\.|\.spec\.|jest\.config|tsconfig/.test(path)) score -= 5;
    switch (taskType) {
      case "styling":
        if (/\.css$/.test(path) || /style|theme/.test(path)) score += 15;
        break;
      case "testing":
        if (/test|spec/.test(path)) score += 20;
        break;
      case "security":
        if (/auth|session|token|password/.test(path)) score += 15;
        break;
      case "bugfix":
        if (/error|handler|except|fail/.test(path)) score += 8;
        break;
      default:
        break;
    }
    return { path, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Pass 2 — read the top candidates' heads from disk, score by keyword hits
  // with signature extraction, keep the strongest MAX_FILES.
  const kept: Array<{ path: string; head: string | null; window: string | null; score: number }> = [];
  const readers = scored.slice(0, MAX_CANDIDATE_READS + MAX_FILES);
  let reads = 0;
  const heads: Array<{ path: string; head: string; full: string; score: number; sigs: string[] }> = [];
  for (const cand of readers) {
    if (reads >= MAX_CANDIDATE_READS) break;
    reads++;
    const full = await readFile(cand.path).catch(() => null);
    if (full === null || full === "") continue;
    const head = truncateHead(full);
    let score = cand.score;
    const headLower = head.toLowerCase();
    for (const kw of keywords) if (headLower.includes(kw)) score += 5;
    const sigs: string[] = [];
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const)\s+\w+/.test(t)) {
        sigs.push(t);
        if (sigs.length >= 25) break;
      }
    }
    heads.push({ path: cand.path, head, full, score, sigs });
  }
  heads.sort((a, b) => b.score - a.score || a.full.length - b.full.length);

  let context =
    `[WORKSPACE: ${directoryName}]\nDirectory:\n` +
    (() => {
      const treeStr = buildFileTreeString(fileTree);
      const treeLines = treeStr.split("\n");
      return treeLines.length > 200
        ? treeLines.slice(0, 150).join("\n") + `\n... (${treeLines.length - 150} more files)`
        : treeStr;
    })() +
    "\n\n";

  for (const h of heads) {
    if (kept.length >= MAX_FILES) break;
    if (context.length + h.head.length > CONTEXT_CAP_CHARS) break;
    kept.push({ path: h.path, head: null, window: h.head, score: h.score });
    context += `\n--- ${h.path} (head ${Math.min(HEAD_LINES, h.head.split("\n").length)} lines) ---\n${h.head}\n`;
  }

  // Signatures for strong files NOT included in full — the model asks
  // read_file for details instead of the builder materializing more text.
  const includedPaths = new Set(kept.map((k) => k.path));
  let sigContent = "";
  for (const h of heads) {
    if (includedPaths.has(h.path) || h.sigs.length === 0) continue;
    if (sigContent.length > 40_000) break;
    sigContent += `\n--- ${h.path} (signatures) ---\n${h.sigs.join("\n")}\n`;
  }
  if (sigContent) context += `\nSignatures (remaining scored files — use read_file for details):\n${sigContent}\n`;
  context += `\nUser request: ${userMessage}`;

  const includedChars = kept.reduce((sum, k) => sum + (k.window?.length ?? 0), 0);
  return {
    context,
    includedFiles: kept.length,
    totalFiles: allPaths.length,
    estimatedTokens: estimateTokens(context) + estimateTokens(sigContent),
  };
}

export interface M3CompatResult {
  context: string;
  includedFiles: number;
  totalFiles: number;
  estimatedTokens: number;
}

/**
 * Legacy synchronous signature retained for callers/tests that previously
 * passed a cached content map. It now composes the SAME bounded output from
 * whatever the map holds — but callers should use buildDiskContext, which
 * reads the workspace from disk per candidate instead of relying on a
 * resident cache.
 */
export function buildM3Context(
  fileTree: any[],
  fileContents: Record<string, string>,
  userMessage: string,
  directoryName: string
): M3CompatResult {
  const entries = Object.entries(fileContents);
  const totalFiles = entries.length;

  // Simple greeting skip
  const trimmed = userMessage.trim().toLowerCase();
  if (trimmed.length < 20 && SIMPLE_PATTERNS.test(trimmed)) {
    return { context: userMessage, includedFiles: 0, totalFiles: 0, estimatedTokens: estimateTokens(userMessage) };
  }

  const keywords = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 15);
  const taskType = detectTaskType(userMessage);

  const treeStr = buildFileTreeString(fileTree);
  const treeLines = treeStr.split("\n");
  const truncatedTree = treeLines.length > 200
    ? treeLines.slice(0, 150).join("\n") + `\n... (${treeLines.length - 150} more files)`
    : treeStr;

  // Score WITHOUT contents first (path heuristics only).
  const scoredPath = entries.map(([path]) => {
    const pathLower = path.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (pathLower.includes(kw)) score += 20;
    if (/\.(ts|tsx|js|jsx)$/.test(path) && !path.includes(".test.")) score += 3;
    if (path.includes("index.") || path.includes("page.") || path.includes("layout.")) score += 5;
    if (/\.test\.|\.spec\.|jest\.config|tsconfig/.test(path)) score -= 5;
    switch (taskType) {
      case "styling":
        if (/\.css$/.test(path) || /style|theme/.test(path)) score += 15;
        break;
      case "testing":
        if (/test|spec/.test(path)) score += 20;
        break;
      case "security":
        if (/auth|session|token|password/.test(path)) score += 15;
        break;
      default:
        break;
    }
    return { path, score };
  });
  scoredPath.sort((a, b) => b.score - a.score);

  const map = new Map(entries);
  let tier1Content = "";
  let tier1Count = 0;
  let tier1Tokens = 0;
  const includedPaths = new Set<string>();
  const sigContent: string[] = [];

  for (const { path, score } of scoredPath) {
    const content = map.get(path);
    if (content === undefined) continue;
    const head = truncateHead(content);
    // keyword hits inside the head raise the effective score for inclusion
    let effective = score;
    const headLower = head.toLowerCase();
    for (const kw of keywords) if (headLower.includes(kw)) effective += 5;

    if (includedPaths.size < MAX_FILES && tier1Tokens + estimateTokens(head) <= 280_000) {
      tier1Content += `\n--- ${path} (head) ---\n${head}\n`;
      tier1Tokens += estimateTokens(head);
      tier1Count++;
      includedPaths.add(path);
      continue;
    }
    // Signature block for remaining strong files
    let sigs: string[] = [];
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const)\s+\w+/.test(t)) {
        sigs.push(t);
        if (sigs.length >= 25) break;
      }
    }
    if (sigs.length > 0 && sigContent.join("").length < 40_000) {
      sigContent.push(`\n--- ${path} (signatures) ---\n${sigs.join("\n")}\n`);
    }
    void score;
  }

  const context =
    `[WORKSPACE: ${directoryName}]\n` +
    `Directory:\n${truncatedTree}\n\n` +
    (tier1Content ? `Files (${tier1Count} of ${totalFiles}; head windows only — full files stay on disk, use read_file):\n${tier1Content}\n` : "") +
    (sigContent.length ? `\nSignatures (remaining scored files — use read_file for details):\n${sigContent.join("")}\n` : "") +
    `\nUser request: ${userMessage}`;

  const sigTokens = estimateTokens(sigContent.join(""));
  return {
    context,
    includedFiles: tier1Count,
    totalFiles,
    estimatedTokens: tier1Tokens + sigTokens,
  };
}

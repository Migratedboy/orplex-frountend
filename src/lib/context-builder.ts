// context-builder.ts — M3-aware context packaging
// M3 has 1M token context — we can send much more than signatures
// Strategy: full file contents for small repos, tiered for large repos

interface ContextResult {
  context: string;
  includedFiles: number;
  totalFiles: number;
  estimatedTokens: number;
}

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

/** Resolve a relative import path to an absolute file path */
function resolveImport(fromFile: string, importPath: string): string | null {
  const dir = fromFile.replace(/\/[^/]+$/, "");
  const parts = (dir ? dir + "/" : "") + importPath;
  // Normalize path segments
  const resolved: string[] = [];
  for (const part of parts.split("/")) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  const candidate = resolved.join("/");
  // Try common extensions
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  for (const ext of exts) {
    // We can't check filesystem here, just return the normalized path
    return candidate + ext;
  }
  return candidate;
}

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

export function buildM3Context(
  fileTree: any[],
  fileContents: Record<string, string>,
  userMessage: string,
  directoryName: string
): ContextResult {
  // Skip for simple greetings
  const trimmed = userMessage.trim().toLowerCase();
  if (trimmed.length < 20 && SIMPLE_PATTERNS.test(trimmed)) {
    return { context: userMessage, includedFiles: 0, totalFiles: 0, estimatedTokens: 0 };
  }

  const entries = Object.entries(fileContents);
  const totalFiles = entries.length;

  // Estimate total tokens if we send everything
  const totalContent = entries.map(([p, c]) => `--- ${p} ---\n${c}`).join("\n\n");
  const totalTokens = estimateTokens(totalContent);

  // M3 context budget: 800K tokens (leaves room for system prompt + response)
  const MAX_TOKENS = 800_000;

  // Always include file tree (even for large repos)
  const treeStr = buildFileTreeString(fileTree);
  const treeTokens = estimateTokens(treeStr);
  const treeLines = treeStr.split("\n");
  const truncatedTree = treeLines.length > 200
    ? treeLines.slice(0, 150).join("\n") + `\n... (${treeLines.length - 150} more files)`
    : treeStr;

  // Small repo: send EVERYTHING (M3 can handle it)
  if (totalTokens + treeTokens < MAX_TOKENS) {
    let context = `[WORKSPACE: ${directoryName}]\nDirectory:\n${truncatedTree}\n\n`;
    context += `Full file contents (${totalFiles} files):\n${totalContent}\n\n`;
    context += `User request: ${userMessage}`;
    return { context, includedFiles: totalFiles, totalFiles, estimatedTokens: totalTokens + treeTokens };
  }

  // Large repo: tiered approach with task-type awareness
  // Tier 1: Full contents of most relevant files (up to 500K tokens)
  // Tier 2: Signatures for remaining files (up to 200K tokens)

  // Detect task type for smarter prioritization
  const taskType = detectTaskType(userMessage);

  // Score files by keyword relevance + import graph + task type
  const keywords = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 15);

  // Build import graph: which files import which
  const importGraph = new Map<string, Set<string>>();
  for (const [path, content] of entries) {
    const imports = new Set<string>();
    const importMatches = content.matchAll(/from\s+['"](.+?)['"]/g);
    for (const m of importMatches) {
      const imported = m[1];
      // Resolve relative imports
      if (imported.startsWith("./") || imported.startsWith("../")) {
        const resolved = resolveImport(path, imported);
        if (resolved) imports.add(resolved);
      }
    }
    importGraph.set(path, imports);
  }

  const scored = entries.map(([path, content]) => {
    let score = 0;
    const pathLower = path.toLowerCase();
    for (const kw of keywords) {
      if (pathLower.includes(kw)) score += 20;
      if (content.toLowerCase().includes(kw)) score += 5;
    }
    // Prefer source files
    if (/\.(ts|tsx|js|jsx)$/.test(path) && !path.includes(".test.")) score += 3;
    // Prefer entry points
    if (path.includes("index.") || path.includes("page.") || path.includes("layout.")) score += 5;
    // Prefer smaller files
    if (content.length < 5000) score += 3;
    // Deprioritize test/config files
    if (/\.test\.|\.spec\.|jest\.config|tsconfig/.test(path)) score -= 5;
    // Boost files that are imported by many others (hub files)
    let importedBy = 0;
    for (const [, deps] of importGraph) {
      if (deps.has(path)) importedBy++;
    }
    score += Math.min(importedBy * 3, 15);
    // Task-type based boosts
    if (taskType === "bugfix") {
      if (/error|catch|throw|exception/.test(content)) score += 10;
      if (/test|spec/.test(path) && path.includes("test")) score += 5;
    } else if (taskType === "feature") {
      if (/component|page|route/.test(path)) score += 8;
      if (/index\.tsx?$/.test(path)) score += 5;
    } else if (taskType === "refactor") {
      if (/util|helper|lib/.test(path)) score += 8;
      importedBy > 2 && (score += 10); // Hub files are key refactoring targets
    } else if (taskType === "styling") {
      if (/\.css$/.test(path) || /style|theme/.test(path)) score += 15;
    } else if (taskType === "testing") {
      if (/test|spec/.test(path)) score += 20;
    } else if (taskType === "security") {
      if (/auth|session|token|password/.test(path)) score += 15;
    }
    return { path, content, score, tokens: estimateTokens(content) };
  });

  scored.sort((a, b) => b.score - a.score || a.tokens - b.tokens);

  // Tier 1: full contents
  let tier1Content = "";
  let tier1Tokens = 0;
  let tier1Count = 0;
  const includedPaths = new Set<string>();

  for (const file of scored) {
    if (tier1Tokens + file.tokens > 500_000) break;
    tier1Content += `\n--- ${file.path} ---\n${file.content}\n`;
    tier1Tokens += file.tokens;
    tier1Count++;
    includedPaths.add(file.path);
  }

  // Tier 2: signatures for remaining files
  let tier2Content = "";
  let tier2Tokens = 0;

  // Simple signature extraction (first line of functions/classes/interfaces)
  for (const file of scored) {
    if (includedPaths.has(file.path)) continue;
    if (tier2Tokens > 200_000) break;

    const lines = file.content.split("\n");
    const sigs: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const)\s+\w+/.test(trimmed)) {
        sigs.push(trimmed);
      }
    }
    if (sigs.length > 0) {
      const sigBlock = `\n--- ${file.path} (signatures) ---\n${sigs.join("\n")}\n`;
      tier2Content += sigBlock;
      tier2Tokens += estimateTokens(sigBlock);
    }
  }

  const context =
    `[WORKSPACE: ${directoryName}]\n` +
    `Directory:\n${truncatedTree}\n\n` +
    `Full file contents (${tier1Count} files):\n${tier1Content}\n` +
    (tier2Content ? `\nSignatures (remaining files — use read_file for details):\n${tier2Content}\n` : "") +
    `\nUser request: ${userMessage}`;

  return {
    context,
    includedFiles: tier1Count,
    totalFiles,
    estimatedTokens: tier1Tokens + tier2Tokens + treeTokens,
  };
}

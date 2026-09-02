// client-signatures.ts — Browser-side signature extraction
// Extracts function, class, interface, type, and export declarations
// from TypeScript/JavaScript source files using regex (no AST parser needed)
// This is the client-side equivalent of lib/agent/ast/parser.ts

// === Types ===

export interface FileSignature {
  path: string;
  signatures: string[];
  score: number;
  size: number;
}

// === Signature extraction ===

const SIG_PATTERNS = [
  // Exported/default functions
  /^export\s+(default\s+)?(?:async\s+)?function\s+(\w+)/gm,
  // Regular functions
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
  // Exported/default classes
  /^export\s+(default\s+)?class\s+(\w+)/gm,
  // Regular classes
  /^(?:export\s+)?class\s+(\w+)/gm,
  // Exported interfaces
  /^export\s+interface\s+(\w+)/gm,
  // Regular interfaces
  /^interface\s+(\w+)/gm,
  // Exported types
  /^export\s+type\s+(\w+)/gm,
  // Regular types
  /^type\s+(\w+)/gm,
  // Exported consts (non-arrow)
  /^export\s+const\s+(\w+)\s*=/gm,
  // React component exports
  /^export\s+default\s+function\s+(\w+)/gm,
];

/**
 * Extract signature declarations from source code.
 * Returns just the declaration line (not the body).
 */
export function extractSignatures(content: string, filePath: string): string[] {
  const signatures: string[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, imports, requires
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ") || trimmed.startsWith("require(")) continue;

    // Match function declarations
    const fnMatch = trimmed.match(/^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)(\s*<[^>]*>)?\s*\(([^)]*)\)\s*:\s*(\S+)/);
    if (fnMatch && !seen.has(fnMatch[4])) {
      const exported = fnMatch[1] ? "export " : "";
      const isDefault = fnMatch[2] ? "default " : "";
      const isAsync = fnMatch[3] ? "async " : "";
      const name = fnMatch[4];
      const generics = fnMatch[5] || "";
      const params = fnMatch[6].length > 60 ? fnMatch[6].slice(0, 60) + "..." : fnMatch[6];
      const returnType = fnMatch[7];
      signatures.push(`${exported}${isDefault}${isAsync}function ${name}${generics}(${params}): ${returnType}`);
      seen.add(name);
      continue;
    }

    // Match class declarations
    const classMatch = trimmed.match(/^(export\s+)?(default\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/);
    if (classMatch && !seen.has(classMatch[3])) {
      const exported = classMatch[1] ? "export " : "";
      const isDefault = classMatch[2] ? "default " : "";
      const name = classMatch[3];
      const extends_ = classMatch[4] || "";
      signatures.push(`${exported}${isDefault}class ${name}${extends_}`);
      seen.add(name);
      continue;
    }

    // Match interface declarations
    const ifaceMatch = trimmed.match(/^(export\s+)?interface\s+(\w+)/);
    if (ifaceMatch && !seen.has(ifaceMatch[2])) {
      const exported = ifaceMatch[1] ? "export " : "";
      signatures.push(`${exported}interface ${ifaceMatch[2]}`);
      seen.add(ifaceMatch[2]);
      continue;
    }

    // Match type declarations
    const typeMatch = trimmed.match(/^(export\s+)?type\s+(\w+)/);
    if (typeMatch && !seen.has(typeMatch[2])) {
      const exported = typeMatch[1] ? "export " : "";
      signatures.push(`${exported}type ${typeMatch[2]}`);
      seen.add(typeMatch[2]);
      continue;
    }

    // Match const with arrow/function (exported only, to avoid noise)
    const constMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/);
    if (constMatch && !seen.has(constMatch[1])) {
      const name = constMatch[1];
      // Skip constants (ALL_CAPS)
      if (!/^[A-Z_]+$/.test(name)) {
        signatures.push(`export const ${name}`);
        seen.add(name);
      }
      continue;
    }
  }

  return signatures;
}

// === File ranking ===

const ALWAYS_INCLUDE = new Set(["package.json", "tsconfig.json", ".env", ".env.example"]);

/**
 * Score a file by relevance to the user's message.
 */
export function scoreFile(
  filePath: string,
  content: string,
  keywords: string[]
): number {
  let score = 0;
  const pathLower = filePath.toLowerCase();
  const fileName = pathLower.split("/").pop() || pathLower;

  // Always include config files
  if (ALWAYS_INCLUDE.has(fileName)) score += 100;

  // Filename keyword matches (high weight)
  for (const kw of keywords) {
    if (pathLower.includes(kw)) score += 20;
  }

  // Content keyword matches (scan first 2KB)
  const contentLower = content.toLowerCase().slice(0, 2000);
  for (const kw of keywords) {
    if (contentLower.includes(kw)) score += 5;
  }

  // Prefer source files over test/config
  if (/\.(ts|tsx|js|jsx)$/.test(fileName) && !fileName.includes(".test.") && !fileName.includes(".spec.")) {
    score += 3;
  }

  // Prefer smaller files (more likely to be focused)
  if (content.length < 2000) score += 3;
  else if (content.length < 5000) score += 1;

  // Prefer entry points
  if (fileName.includes("index.") || fileName.includes("page.") || fileName.includes("layout.")) {
    score += 5;
  }

  // Prefer files in src/ over other dirs
  if (pathLower.startsWith("src/")) score += 2;

  return score;
}

/**
 * Extract keywords from user message (lowercase, 3+ chars, not stop words).
 */
export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the","a","an","is","are","was","were","be","been","have","has","had",
    "do","does","did","will","would","could","should","can","need","to",
    "of","in","for","on","with","at","by","from","as","this","that","it",
    "and","but","or","if","not","no","all","each","every","any","some",
    "other","such","only","own","same","so","than","too","very","just",
    "about","also","how","what","when","where","who","which","why","me",
    "my","we","our","you","your","he","she","him","her","its","they",
    "them","their","i","am","been","being","into","through","during",
    "before","after","above","below","between","out","off","over","under",
    "again","further","then","once","here","there","s","t","don","now",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 15);
}

/**
 * Build compact context from workspace files.
 * Returns signatures + file tree, NOT full file contents.
 */
export function buildWorkspaceContext(
  fileTree: any[],
  fileContents: Record<string, string>,
  userMessage: string,
  activeDirName: string
): { context: string; includedCount: number; excludedCount: number } {
  // Skip workspace context for simple greetings / short messages
  const trimmed = userMessage.trim().toLowerCase();
  const isSimple = trimmed.length < 20 && /^(hi|hello|hey|thanks|thank you|ok|yes|no|help|bye|sup|yo|hola|howdy|greetings|what'?s up|what's good|how are you|good morning|good night|cool|nice|great|awesome|perfect|awesome|bye|cya|see ya|later|peace)/.test(trimmed);
  if (isSimple) {
    return { context: userMessage, includedCount: 0, excludedCount: 0 };
  }

  const MAX_SIG_CHARS = 30000; // ~7.5K tokens for signatures
  const MAX_FILES = 15;

  // Build file tree string
  const treeStr = buildFileTreeString(fileTree);

  // Extract keywords from user message
  const keywords = extractKeywords(userMessage);

  // Score and rank files
  const entries = Object.entries(fileContents);
  const scored = entries.map(([path, content]) => ({
    path,
    content,
    score: scoreFile(path, content, keywords),
    size: content.length,
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score || a.size - b.size);

  // Extract signatures from top files
  let allSignatures = "";
  let includedCount = 0;

  for (const file of scored.slice(0, MAX_FILES)) {
    const sigs = extractSignatures(file.content, file.path);
    if (sigs.length === 0) continue;

    const sigBlock = `\n--- ${file.path} ---\n${sigs.join("\n")}`;
    if (allSignatures.length + sigBlock.length > MAX_SIG_CHARS) break;

    allSignatures += sigBlock;
    includedCount++;
  }

  const excludedCount = entries.length - includedCount;

  // Truncate file tree if too long (>100 lines)
  const treeLines = treeStr.split("\n");
  const truncatedTree = treeLines.length > 100
    ? treeLines.slice(0, 80).join("\n") + `\n... (${treeLines.length - 80} more files)`
    : treeStr;

  const context =
    `[WORKSPACE: ${activeDirName}]\n` +
    `Directory:\n${truncatedTree}\n\n` +
    (allSignatures
      ? `Signatures (${includedCount} files, ${excludedCount} excluded — use read_file for details):\n${allSignatures}\n\n`
      : "") +
    `User request: ${userMessage}`;

  return { context, includedCount, excludedCount };
}

// === Helper: Build file tree string ===

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

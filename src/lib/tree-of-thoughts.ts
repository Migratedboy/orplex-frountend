/**
 * tree-of-thoughts.ts — Parallel Code Generation Strategy
 * 
 * Generates multiple implementations in parallel and picks the best one
 * based on quality metrics. Mimics how Codex and Antigravity work.
 */

import { analyzeCodeQuality } from './code-quality-checker';

export interface ThoughtBranch {
  id: string;
  name: string;
  approach: string;
  files: Array<{ path: string; content: string }>;
  score: number;
  selected: boolean;
}

export interface ToTResult {
  branches: ThoughtBranch[];
  winner: ThoughtBranch;
  reason: string;
}

// ============================================================
// Strategy Definitions
// ============================================================

const STRATEGIES = [
  {
    id: 'functional',
    name: 'Functional Hooks',
    approach: 'Use React hooks, functional components, custom hooks for reuse. Modern React 18+ patterns.',
    systemSuffix: 'Use functional components with hooks. Create custom hooks for reusable logic. Use useCallback/useMemo for performance.',
  },
  {
    id: 'modular',
    name: 'Modular Architecture',
    approach: 'Separate concerns into distinct modules. Clear file structure with utils, types, components, hooks directories.',
    systemSuffix: 'Create a clean modular architecture with separate files for types, utils, hooks, and components. Max 100 lines per file.',
  },
  {
    id: 'production',
    name: 'Production-Grade',
    approach: 'Maximum error handling, loading states, TypeScript strictness, accessibility. Enterprise-ready code.',
    systemSuffix: 'Write enterprise-grade code with: full error handling, loading/skeleton states, strict TypeScript (no any), ARIA labels, keyboard navigation, and responsive design.',
  },
];

// ============================================================
// Tree-of-Thoughts Execution
// ============================================================

/**
 * Generate multiple implementations and pick the best
 */
export async function runTreeOfThoughts(
  task: string,
  modelCall: (messages: Array<{ role: string; content: string }>) => Promise<string>,
  maxBranches: number = 3
): Promise<ToTResult> {
  const branches: ThoughtBranch[] = [];

  // Generate all branches TRULY in parallel — independent model calls racing
  // the slowest branch, not a serial sum. A failed branch scores 0 and stays
  // in the race rather than failing the whole ToT run.
  const picked = STRATEGIES.slice(0, maxBranches);
  const settled = await Promise.all(
    picked.map(async (strategy) => {
      const prompt = `Build the following. Strategy: ${strategy.approach}\n\n${task}\n\n${strategy.systemSuffix}`;

      let response = "";
      try {
        response = await modelCall([
          { role: 'system', content: `You are a senior developer. ${strategy.approach}` },
          { role: 'user', content: prompt },
        ]);
      } catch (err) {
        response = ""; // failed branch → zero files → score 0, race continues
      }

      // Parse files from response
      const files = parseFilesFromResponse(response);

      // Score the output
      let score = 0;
      for (const file of files) {
        const report = analyzeCodeQuality(file.path, file.content);
        score += report.score;
      }
      score = files.length > 0 ? score / files.length : 0;

      const branch: ThoughtBranch = {
        id: strategy.id,
        name: strategy.name,
        approach: strategy.approach,
        files,
        score,
        selected: false,
      };
      return branch;
    })
  );
  branches.push(...settled);

  // Pick the winner
  const sorted = [...branches].sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  winner.selected = true;

  return {
    branches,
    winner,
    reason: `Selected "${winner.name}" (score: ${winner.score.toFixed(0)}/100) over ${branches.length - 1} alternatives`,
  };
}

/**
 * Parse files from model response
 */
function parseFilesFromResponse(response: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Extract from write_file tool calls
  const pattern = /write_file\(\{[^}]*?"path"\s*:\s*"([^"]+)"[^}]*?"content"\s*:\s*"([\s\S]*?)"\s*\}/g;
  let match;
  while ((match = pattern.exec(response)) !== null) {
    files.push({ path: match[1], content: match[2] });
  }

  return files;
}

/**
 * reflection-loop.ts — Self-Correcting Code Generation
 * 
 * After M3 generates code, this module reviews it and sends
 * corrections back for another generation pass.
 */

import { analyzeCodeQuality, analyzeProjectQuality, type QualityReport } from './code-quality-checker';

export interface ReflectionResult {
  originalScore: number;
  finalScore: number;
  iterations: number;
  fixes: string[];
  files: Array<{ path: string; content: string }>;
}

/**
 * Run the reflection loop on generated code.
 * Returns improved code with quality issues fixed.
 */
export async function runReflectionLoop(
  files: Array<{ path: string; content: string }>,
  modelCall: (messages: Array<{ role: string; content: string }>) => Promise<string>,
  maxIterations: number = 3
): Promise<ReflectionResult> {
  let currentFiles = [...files];
  let fixes: string[] = [];
  let iteration = 0;

  // Initial quality check
  const initialReport = analyzeProjectQuality(currentFiles);
  let currentScore = initialReport.overallScore;

  while (iteration < maxIterations && currentScore < 85) {
    iteration++;

    // Get the issues to fix
    const report = analyzeProjectQuality(currentFiles);
    const criticalIssues = report.topIssues.filter((i: { severity: string }) => i.severity === 'error' || i.severity === 'warning');

    if (criticalIssues.length === 0) break;

    // Build the reflection prompt
    const issueSummary = criticalIssues
      .slice(0, 5)
      .map((i: { severity: string; category: string; message: string; line?: number }) => `- [${i.severity}] ${i.category}: ${i.message} (line ${i.line || '?'})`)
      .join('\n');

    const fileList = currentFiles.map(f => `### ${f.path}\n\`\`\`${f.path.endsWith('.tsx') || f.path.endsWith('.ts') ? 'typescript' : 'css'}\n${f.content.slice(0, 2000)}${f.content.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``).join('\n\n');

    const reflectionPrompt = `You are reviewing code you just generated. Here are the quality issues found:

${issueSummary}

Current files:
${fileList}

FIX ALL ISSUES above. Return the COMPLETE fixed files using write_file tool calls. Do NOT explain — just fix the code.`;

    // Call the model to fix issues
    const fixedResponse = await modelCall([
      { role: 'system', content: 'You are a code reviewer. Fix all issues in the provided code. Return complete fixed files.' },
      { role: 'user', content: reflectionPrompt },
    ]);

    // Parse the fixed files from the response
    const fixedFiles = parseToolCalls(fixedResponse);
    if (fixedFiles.length > 0) {
      currentFiles = fixedFiles;
      fixes.push(`Iteration ${iteration}: Fixed ${criticalIssues.length} issues`);
    }

    // Re-check quality
    const newReport = analyzeProjectQuality(currentFiles);
    const newScore = newReport.overallScore;

    if (newScore <= currentScore) break; // No improvement
    currentScore = newScore;
  }

  return {
    originalScore: initialReport.overallScore,
    finalScore: currentScore,
    iterations: iteration,
    fixes,
    files: currentFiles,
  };
}

/**
 * Parse tool calls from model response (simplified)
 */
function parseToolCalls(response: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Try to extract write_file calls from the response
  const writePattern = /write_file\(\{[^}]*path:\s*["']([^"']+)["'][^}]*content:\s*["']([\s\S]*?)["']\s*\}/g;
  let match;
  while ((match = writePattern.exec(response)) !== null) {
    files.push({ path: match[1], content: match[2] });
  }

  // Also try JSON format
  const jsonPattern = /"path":\s*"([^"]+)",\s*"content":\s*"([\s\S]*?)"/g;
  while ((match = jsonPattern.exec(response)) !== null) {
    if (!files.some(f => f.path === match![1])) {
      files.push({ path: match[1], content: match[2] });
    }
  }

  return files;
}

/**
 * Quick quality check without model call
 */
export function quickQualityCheck(files: Array<{ path: string; content: string }>): {
  score: number;
  criticalCount: number;
  summary: string;
} {
  const report = analyzeProjectQuality(files);
  const criticalCount = report.topIssues.filter((i: { severity: string }) => i.severity === 'error').length;

  return {
    score: report.overallScore,
    criticalCount,
    summary: report.summary,
  };
}

/**
 * code-quality-checker.ts — Post-Generation Code Quality Analysis
 * 
 * Analyzes generated code and provides quality scores + auto-fixes.
 * Used by the reflection loop to improve code before delivery.
 */

export interface QualityIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  line?: number;
  fix?: string;
}

export interface QualityReport {
  score: number; // 0-100
  issues: QualityIssue[];
  suggestions: string[];
  autoFixes: Array<{ file: string; oldText: string; newText: string }>;
}

// ============================================================
// Pattern Detection
// ============================================================

const BAD_PATTERNS: Array<{ pattern: RegExp; category: string; message: string; severity: QualityIssue['severity'] }> = [
  // TypeScript quality
  { pattern: /:\s*any\b/g, category: 'type-safety', message: 'Avoid `any` type — use specific types', severity: 'warning' },
  { pattern: /@ts-ignore/g, category: 'type-safety', message: 'Avoid @ts-ignore — fix the underlying type issue', severity: 'warning' },
  { pattern: /as\s+any/g, category: 'type-safety', message: 'Avoid `as any` cast — use proper typing', severity: 'warning' },

  // Error handling
  { pattern: /\.then\([^)]*\)(?!\.catch)/g, category: 'error-handling', message: 'Promise without .catch() — add error handling', severity: 'warning' },
  { pattern: /async\s+\w+\s*\([^)]*\)\s*\{[^}]*\}(?!\s*catch)/g, category: 'error-handling', message: 'Async function without try/catch', severity: 'info' },

  // React patterns
  { pattern: /useState\(\[\]\)/g, category: 'react', message: 'Consider typing useState with generic: useState<Type[]>([])', severity: 'info' },
  { pattern: /key=\{index\}/g, category: 'react', message: 'Avoid using index as key — use unique IDs', severity: 'warning' },
  { pattern: /dangerouslySetInnerHTML/g, category: 'security', message: 'dangerouslySetInnerHTML is a security risk — sanitize input', severity: 'error' },

  // Security
  { pattern: /eval\(/g, category: 'security', message: 'eval() is a security risk — avoid it', severity: 'error' },
  { pattern: /innerHTML\s*=/g, category: 'security', message: 'Direct innerHTML assignment is XSS vulnerable', severity: 'error' },
  { pattern: /password|secret|api_key|apikey/gi, category: 'security', message: 'Potential hardcoded secret detected', severity: 'error' },

  // Performance
  { pattern: /useEffect\(\(\)\s*=>\s*\{[^}]*fetch/g, category: 'performance', message: 'fetch in useEffect without cleanup — add AbortController', severity: 'warning' },
  { pattern: /JSON\.parse\(.*JSON\.stringify/g, category: 'performance', message: 'Deep clone via JSON — use structuredClone() or lodash.cloneDeep', severity: 'info' },

  // Code style
  { pattern: /var\s+/g, category: 'style', message: 'Use const/let instead of var', severity: 'warning' },
  { pattern: /==\s*[^=]/g, category: 'style', message: 'Use === instead of ==', severity: 'info' },
  { pattern: /console\.(log|debug|info)\(/g, category: 'style', message: 'Remove console.log in production code', severity: 'info' },
];

// ============================================================
// Quality Scoring
// ============================================================

function calculateScore(issues: QualityIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'error') score -= 10;
    else if (issue.severity === 'warning') score -= 3;
    else if (issue.severity === 'info') score -= 1;
  }
  return Math.max(0, Math.min(100, score));
}

// ============================================================
// Auto-Fix Generation
// ============================================================

function generateAutoFixes(content: string, filePath: string): QualityReport['autoFixes'] {
  const fixes: QualityReport['autoFixes'] = [];

  // Fix var → const/let
  if (/\bvar\s+/.test(content)) {
    fixes.push({
      file: filePath,
      oldText: content.match(/var\s+\w+/)?.[0] || '',
      newText: content.match(/var\s+(\w+)/)?.[0]?.replace('var', 'const') || '',
    });
  }

  // Fix == → ===
  if (/==\s*[^=]/.test(content) && !/!==/.test(content)) {
    const match = content.match(/(\w+)\s*==\s*(\w+)/);
    if (match) {
      fixes.push({
        file: filePath,
        oldText: `${match[1]} == ${match[2]}`,
        newText: `${match[1]} === ${match[2]}`,
      });
    }
  }

  return fixes;
}

// ============================================================
// Main Analysis Function
// ============================================================

export function analyzeCodeQuality(filePath: string, content: string): QualityReport {
  const issues: QualityIssue[] = [];
  const suggestions: string[] = [];

  // Check each pattern
  for (const { pattern, category, message, severity } of BAD_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      issues.push({ severity, category, message, line: lineNum });
    }
  }

  // Check for missing imports
  if (content.includes('useState') && !content.includes("from 'react'") && !content.includes('from "react"')) {
    issues.push({ severity: 'warning', category: 'imports', message: 'Missing React import' });
  }

  // Check for large files without error boundaries
  if (content.length > 5000 && filePath.endsWith('.tsx') && !content.includes('ErrorBoundary') && !content.includes('error')) {
    suggestions.push('Consider wrapping this component in an ErrorBoundary');
  }

  // Check for missing prop types
  if (filePath.endsWith('.tsx') && content.includes('export default function') && !content.includes('interface') && !content.includes('type ')) {
    suggestions.push('Add TypeScript interface for component props');
  }

  // Generate auto-fixes
  const autoFixes = generateAutoFixes(content, filePath);

  return {
    score: calculateScore(issues),
    issues,
    suggestions,
    autoFixes,
  };
}

// ============================================================
// Batch Analysis
// ============================================================

export function analyzeProjectQuality(files: Array<{ path: string; content: string }>): {
  overallScore: number;
  fileReports: Array<{ path: string; report: QualityReport }>;
  topIssues: QualityIssue[];
  summary: string;
} {
  const fileReports = files.map(f => ({
    path: f.path,
    report: analyzeCodeQuality(f.path, f.content),
  }));

  const overallScore = fileReports.reduce((sum, f) => sum + f.report.score, 0) / fileReports.length;

  const allIssues = fileReports.flatMap(f => f.report.issues);
  const topIssues = allIssues
    .sort((a, b) => {
      const order = { error: 0, warning: 1, info: 2 };
      return order[a.severity] - order[b.severity];
    })
    .slice(0, 10);

  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;

  const summary = `Quality Score: ${overallScore.toFixed(0)}/100 | ${errorCount} errors, ${warningCount} warnings across ${files.length} files`;

  return { overallScore, fileReports, topIssues, summary };
}

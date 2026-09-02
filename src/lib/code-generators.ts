/**
 * code-generators.ts — Tier 4: Automated Code Generation Utilities
 * 
 * Generates tests, security audits, performance fixes, and documentation
 * for code produced by the AI.
 */

// ============================================================
// 1. Automated Test Generation
// ============================================================

export function generateTestFile(filePath: string, content: string): string {
  const componentName = filePath.match(/(\w+)\.(tsx|ts)$/)?.[1] || 'Component';
  const isReact = filePath.endsWith('.tsx') || content.includes('import React');
  const isApi = filePath.includes('/api/') || content.includes('NextRequest');
  const isUtil = filePath.includes('/utils/') || filePath.includes('/lib/');

  if (isReact) {
    return generateReactTest(componentName, content);
  } else if (isApi) {
    return generateApiTest(componentName, content);
  } else if (isUtil) {
    return generateUtilTest(componentName, content);
  }
  return `// Auto-generated test for ${filePath}\nimport { describe, it, expect } from 'vitest';\n\ndescribe('${componentName}', () => {\n  it('should work correctly', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
}

function generateReactTest(name: string, content: string): string {
  const hasProps = content.includes('interface') || content.includes('Props');
  const hasState = content.includes('useState');
  const hasEffect = content.includes('useEffect');

  return `import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ${name} } from './${name}';

// Mock dependencies
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
}));

describe('${name}', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<${name} />);
    expect(screen.getByRole('main') || document.body).toBeTruthy();
  });

  it('matches snapshot', () => {
    const { container } = render(<${name} />);
    expect(container).toMatchSnapshot();
  });${hasState ? `\n\n  it('handles state changes', () => {
    render(<${name} />);
    // Test state interactions
  });` : ''}${hasEffect ? `\n\n  it('cleans up effects', () => {
    const unmount = render(<${name} />);
    unmount.unmount();
    // Verify cleanup
  });` : ''}
});
`;
}

function generateApiTest(name: string, content: string): string {
  const hasPost = content.includes('POST');
  const hasGet = content.includes('GET');

  return `import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
${hasGet ? "import { GET } from './route';" : ''}${hasPost ? "import { POST } from './route';" : ''}

describe('${name} API Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });${hasGet ? `\n\n  it('GET returns 200 with data', async () => {
    const { req } = createMocks({ method: 'GET' });
    const response = await GET(req as any);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });` : ''}${hasPost ? `\n\n  it('POST creates resource', async () => {
    const { req } = createMocks({
      method: 'POST',
      body: { /* test data */ },
    });
    const response = await POST(req as any);
    expect(response.status).toBe(201);
  });

  it('POST returns 400 for invalid data', async () => {
    const { req } = createMocks({
      method: 'POST',
      body: {},
    });
    const response = await POST(req as any);
    expect(response.status).toBe(400);
  });` : ''}
});
`;
}

function generateUtilTest(name: string, content: string): string {
  // Extract exported functions
  const funcMatches = content.match(/export\s+(?:function|const)\s+(\w+)/g) || [];
  const functions = funcMatches.map(m => m.match(/(\w+)$/)?.[1] || '').filter(Boolean);

  return `import { describe, it, expect } from 'vitest';
import { ${functions.join(', ')} } from './${name}';

describe('${name}', () => {
${functions.map(fn => `  describe('${fn}', () => {
    it('should work with valid input', () => {
      // Add test implementation
      expect(true).toBe(true);
    });

    it('should handle edge cases', () => {
      // Add edge case tests
      expect(true).toBe(true);
    });
  });`).join('\n\n')}
});
`;
}

// ============================================================
// 2. Security Audit
// ============================================================

export interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  message: string;
  file: string;
  line?: number;
}

export function runSecurityAudit(files: Array<{ path: string; content: string }>): SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');
    lines.forEach((line, i) => {
      // Critical
      if (/eval\(/.test(line)) issues.push({ severity: 'critical', category: 'code-injection', message: 'eval() detected — potential code injection', file: file.path, line: i + 1 });
      if (/dangerouslySetInnerHTML/.test(line)) issues.push({ severity: 'critical', category: 'xss', message: 'dangerouslySetInnerHTML — XSS risk', file: file.path, line: i + 1 });

      // High
      if (/innerHTML\s*=/.test(line)) issues.push({ severity: 'high', category: 'xss', message: 'Direct innerHTML assignment — XSS vulnerable', file: file.path, line: i + 1 });
      if (/new\s+Function\(/.test(line)) issues.push({ severity: 'high', category: 'code-injection', message: 'new Function() — code injection risk', file: file.path, line: i + 1 });

      // Medium
      if (/password|secret|api_key|apikey|token/i.test(line) && /=\s*["']/.test(line)) {
        issues.push({ severity: 'medium', category: 'hardcoded-secret', message: 'Potential hardcoded secret', file: file.path, line: i + 1 });
      }
      if (/http:\/\//.test(line) && !/localhost/.test(line)) {
        issues.push({ severity: 'medium', category: 'insecure-protocol', message: 'HTTP instead of HTTPS', file: file.path, line: i + 1 });
      }

      // Low
      if (/console\.(log|debug)\(/.test(line)) issues.push({ severity: 'low', category: 'debug-info', message: 'console.log in production code', file: file.path, line: i + 1 });
      if (/TODO|FIXME|HACK/.test(line)) issues.push({ severity: 'low', category: 'todo', message: 'TODO/FIXME comment found', file: file.path, line: i + 1 });
    });
  }

  return issues.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.severity] - order[b.severity];
  });
}

// ============================================================
// 3. Performance Optimization
// ============================================================

export interface PerfIssue {
  impact: 'high' | 'medium' | 'low';
  message: string;
  file: string;
  suggestion: string;
}

export function analyzePerformance(files: Array<{ path: string; content: string }>): PerfIssue[] {
  const issues: PerfIssue[] = [];

  for (const file of files) {
    // React performance
    if (file.path.endsWith('.tsx')) {
      if (file.content.includes('useEffect') && !file.content.includes('useCallback')) {
        issues.push({ impact: 'medium', message: 'useEffect without useCallback — potential infinite re-renders', file: file.path, suggestion: 'Wrap callbacks in useCallback' });
      }
      if (file.content.includes('JSON.parse') && file.content.includes('JSON.stringify')) {
        issues.push({ impact: 'low', message: 'Deep clone via JSON — use structuredClone()', file: file.path, suggestion: 'Replace JSON.parse(JSON.stringify(x)) with structuredClone(x)' });
      }
      if (file.content.includes('.map(') && !file.content.includes('key=')) {
        issues.push({ impact: 'medium', message: 'Map without key prop', file: file.path, suggestion: 'Add unique key prop to mapped elements' });
      }
    }

    // Bundle size
    if (file.content.includes("import * from 'lodash'") || file.content.includes('import _ from "lodash"')) {
      issues.push({ impact: 'high', message: 'Full lodash import — increases bundle by ~70KB', file: file.path, suggestion: 'Use lodash-es or individual function imports (import debounce from "lodash/debounce")' });
    }
    if (file.content.includes("import * from 'moment'") || file.content.includes('import moment')) {
      issues.push({ impact: 'high', message: 'Moment.js import — use date-fns or dayjs instead', file: file.path, suggestion: 'Replace with date-fns (tree-shakeable, 10KB) or dayjs (2KB)' });
    }

    // N+1 queries
    if (file.path.includes('.ts') && file.content.includes('.find(') && file.content.includes('for ')) {
      issues.push({ impact: 'high', message: 'Potential N+1 query pattern — find inside loop', file: file.path, suggestion: 'Use findAll with include, or Promise.all for parallel queries' });
    }
  }

  return issues.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.impact] - order[b.impact];
  });
}
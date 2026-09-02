/**
 * rag-retriever.ts — Retrieval-Augmented Generation for Code
 * 
 * Before generating code, retrieves relevant patterns from:
 * - Existing codebase
 * - Cached successful patterns
 * - Best practice templates
 */

export interface CodePattern {
  id: string;
  category: string;
  language: string;
  content: string;
  qualityScore: number;
  usageCount: number;
  tags: string[];
}

// ============================================================
// Built-in Pattern Library (Best Practices)
// ============================================================

const PATTERN_LIBRARY: CodePattern[] = [
  {
    id: 'react-component-ts',
    category: 'component',
    language: 'typescript',
    content: `import React, { useState, useEffect, useCallback } from 'react';

interface ComponentProps {
  // Define typed props here
}

export const Component: React.FC<ComponentProps> = ({ prop1, prop2 }) => {
  const [state, setState] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/data');
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchData();
    return () => controller.abort();
  }, [fetchData]);

  if (loading) return <div className="animate-pulse">Loading...</div>;
  if (error) return <div className="text-red-500">{error}</div>;

  return <div>{/* Component content */}</div>;
};`,
    qualityScore: 95,
    usageCount: 0,
    tags: ['react', 'typescript', 'component', 'hooks', 'error-handling'],
  },
  {
    id: 'api-route-nextjs',
    category: 'api',
    language: 'typescript',
    content: `import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const schema = z.object({
  // Define validation schema
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // Handle GET logic
    return NextResponse.json({ success: true, data: [] });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = schema.parse(body);
    // Handle POST logic
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}`,
    qualityScore: 92,
    usageCount: 0,
    tags: ['nextjs', 'api', 'typescript', 'validation', 'zod'],
  },
  {
    id: 'zustand-store',
    category: 'state',
    language: 'typescript',
    content: `import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppState {
  // Define state shape
  items: Item[];
  loading: boolean;
  error: string | null;
  // Actions
  addItem: (item: Item) => void;
  removeItem: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

interface Item {
  id: string;
  name: string;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      items: [],
      loading: false,
      error: null,
      addItem: (item) => set((state) => ({ items: [...state.items, item] })),
      removeItem: (id) => set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      })),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
    }),
    { name: 'app-storage' }
  )
);`,
    qualityScore: 90,
    usageCount: 0,
    tags: ['zustand', 'state', 'typescript', 'persistence'],
  },
  {
    id: 'error-boundary',
    category: 'error',
    language: 'typescript',
    content: `import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <h2 className="text-red-800 font-semibold">Something went wrong</h2>
          <p className="text-red-600 text-sm mt-1">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 px-3 py-1 bg-red-100 text-red-700 rounded text-sm"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}`,
    qualityScore: 88,
    usageCount: 0,
    tags: ['react', 'error-boundary', 'typescript', 'error-handling'],
  },
  {
    id: 'loading-skeleton',
    category: 'ui',
    language: 'typescript',
    content: [
      "import React from 'react';",
      "",
      "interface SkeletonProps {",
      "  className?: string;",
      "  lines?: number;",
      "}",
      "",
      "export const Skeleton: React.FC<SkeletonProps> = ({ className = '', lines = 1 }) => {",
      "  const widthClass = (idx: number, total: number) => idx === total - 1 ? 'w-3/4' : 'w-full';",
      "  return (",
      "    <div className={\"animate-pulse space-y-2 \" + className}>",
      "      {Array.from({ length: lines }).map((_, i) => (",
      "        <div key={i} className={\"h-4 bg-gray-200 dark:bg-gray-700 rounded \" + widthClass(i, lines)} />",
      "      ))}",
      "    </div>",
      "  );",
      "};",
      "",
      "export const CardSkeleton: React.FC = () => (",
      "  <div className=\"p-4 border rounded-lg animate-pulse\">",
      "    <Skeleton className=\"h-6 w-1/3 mb-4\" />",
      "    <Skeleton lines={3} />",
      "  </div>",
      ");",
      "",
      "export const TableSkeleton: React.FC<{ rows?: number }> = ({ rows = 5 }) => (",
      "  <div className=\"space-y-2\">",
      "    {Array.from({ length: rows }).map((_, i) => (",
      "      <div key={i} className=\"flex space-x-4 animate-pulse\">",
      "        <Skeleton className=\"h-4 w-1/4\" />",
      "        <Skeleton className=\"h-4 w-1/3\" />",
      "        <Skeleton className=\"h-4 w-1/6\" />",
      "      </div>",
      "    ))}",
      "  </div>",
      ");",
    ].join('\n'),
    qualityScore: 85,
    usageCount: 0,
    tags: ['react', 'skeleton', 'loading', 'ui', 'tailwind'],
  },
];

// ============================================================
// RAG Retrieval Functions
// ============================================================

/**
 * Retrieve relevant patterns for a given task
 */
export function retrievePatterns(
  task: string,
  language: string = 'typescript',
  limit: number = 5
): CodePattern[] {
  const taskLower = task.toLowerCase();

  // Score each pattern by relevance
  const scored = PATTERN_LIBRARY
    .filter(p => p.language === language || p.language === 'any')
    .map(pattern => {
      let score = 0;
      for (const tag of pattern.tags) {
        if (taskLower.includes(tag)) score += 10;
      }
      // Boost by quality
      score += pattern.qualityScore / 10;
      // Boost by usage (popularity)
      score += Math.min(pattern.usageCount, 10);
      return { pattern, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => s.pattern);
}

/**
 * Record a successful pattern usage
 */
export function recordPatternUsage(patternId: string): void {
  const pattern = PATTERN_LIBRARY.find(p => p.id === patternId);
  if (pattern) {
    pattern.usageCount++;
  }
}

/**
 * Get all available patterns, optionally filtered by category
 */
export function getAvailablePatterns(category?: string): CodePattern[] {
  if (category) {
    return PATTERN_LIBRARY.filter(p => p.category === category);
  }
  return [...PATTERN_LIBRARY];
}

/**
 * Add a custom pattern to the library (for learned patterns)
 */
export function addPattern(pattern: Omit<CodePattern, 'id' | 'usageCount'>): CodePattern {
  const newPattern: CodePattern = {
    ...pattern,
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    usageCount: 0,
  };
  PATTERN_LIBRARY.push(newPattern);
  return newPattern;
}

/**
 * Get the top N patterns by quality score
 */
export function getTopPatterns(limit: number = 10): CodePattern[] {
  return [...PATTERN_LIBRARY]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, limit);
}

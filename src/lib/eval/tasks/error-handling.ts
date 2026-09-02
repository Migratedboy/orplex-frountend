import type { EvalTask } from "../types";

/**
 * Error handling bug tasks — swallowed errors, missing try/catch,
 * wrong error propagation, unhandled promise rejections.
 */
export const errorHandlingTasks: EvalTask[] = [
  // ── ERR-001 ─────────────────────────────────────────────────────
  {
    id: "ERR-001",
    name: "Swallowed error in async function",
    description:
      "An async function catches errors but doesn't re-throw or log them, " +
      "silently failing.",
    category: "error-handling",
    difficulty: "easy",
    fixInstruction:
      "Fix the error swallowing in src/services/file-writer.ts — the write " +
      "function catches errors but doesn't log or re-throw them. At minimum, " +
      "log the error and return false.",
    initialFiles: [
      {
        path: "src/services/file-writer.ts",
        content: `export async function writeFile(
  path: string,
  content: string
): Promise<boolean> {
  try {
    // Simulates file system write
    if (!path) throw new Error("No path provided");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  } catch (error) {
    // Bug: error is swallowed silently
    return false;
  }
}
`,
      },
    ],
    expectedFiles: {
      "src/services/file-writer.ts": `export async function writeFile(
  path: string,
  content: string
): Promise<boolean> {
  try {
    if (!path) throw new Error("No path provided");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  } catch (error) {
    console.error(\`Failed to write file \${path}:\`, error);
    return false;
  }
}
`,
    },
    assertions: [
      {
        label: "Logs error in catch block",
        check: (files) => {
          const src = files["src/services/file-writer.ts"] || "";
          return src.includes("console.error") || src.includes("console.warn") || src.includes("logger");
        },
      },
    ],
    timeout: 120,
  },

  // ── ERR-002 ─────────────────────────────────────────────────────
  {
    id: "ERR-002",
    name: "Missing error boundary for async component",
    description:
      "A React component does async work but has no error handling, so " +
      "failures crash the entire page.",
    category: "error-handling",
    difficulty: "medium",
    fixInstruction:
      "Fix the missing error handling in src/components/DataLoader.tsx — " +
      "the component fetches data in useEffect but doesn't handle errors. " +
      "Add error state and display a user-friendly error message.",
    initialFiles: [
      {
        path: "src/components/DataLoader.tsx",
        content: `"use client";

import { useState, useEffect } from "react";

export default function DataLoader({ url }: { url: string }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(url)
      .then((r) => r.json())
      .then(setData);
  }, [url]);

  if (!data) return <div>Loading...</div>;

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
`,
      },
    ],
    expectedFiles: {
      "src/components/DataLoader.tsx": `"use client";

import { useState, useEffect } from "react";

export default function DataLoader({ url }: { url: string }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(\`HTTP \${r.status}\`);
        return r.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [url]);

  if (error) return <div role="alert">Error: {error}</div>;
  if (!data) return <div>Loading...</div>;

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
`,
    },
    assertions: [
      {
        label: "Has error state variable",
        check: (files) => {
          const src = files["src/components/DataLoader.tsx"] || "";
          return src.includes("error") && src.includes("useState");
        },
      },
      {
        label: "Catches fetch errors",
        check: (files) => {
          const src = files["src/components/DataLoader.tsx"] || "";
          return src.includes(".catch") || src.includes("try") || src.includes("await");
        },
      },
    ],
    timeout: 120,
  },

  // ── ERR-003 ─────────────────────────────────────────────────────
  {
    id: "ERR-003",
    name: "Incorrect error propagation in Promise chain",
    description:
      "A .then() chain returns a value that masks the error from a " +
      "previous .catch(), preventing upstream error handling.",
    category: "error-handling",
    difficulty: "hard",
    fixInstruction:
      "Fix the error propagation in src/services/api-client.ts — the " +
      "fetchWithRetry function's .catch() returns a default value instead " +
      "of re-throwing, so callers never know the request failed.",
    initialFiles: [
      {
        path: "src/services/api-client.ts",
        content: `export async function fetchWithRetry(
  url: string,
  retries: number = 3
): Promise<any> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      return res.json();
    } catch (error) {
      lastError = error as Error;
    }
  }

  // Bug: returns null instead of throwing, masking the error
  console.error("All retries failed:", lastError);
  return null;
}

// Caller never knows it failed
const data = await fetchWithRetry("/api/data");
console.log(data.name); // TypeError: Cannot read property 'name' of null
`,
      },
    ],
    expectedFiles: {
      "src/services/api-client.ts": `export async function fetchWithRetry(
  url: string,
  retries: number = 3
): Promise<any> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      return res.json();
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw new Error(\`Failed after \${retries} retries: \${lastError?.message}\`);
}

// Caller can catch the error
try {
  const data = await fetchWithRetry("/api/data");
  console.log(data.name);
} catch (error) {
  console.error("Request failed:", error);
}
`,
    },
    assertions: [
      {
        label: "Throws error instead of returning null",
        check: (files) => {
          const src = files["src/services/api-client.ts"] || "";
          return src.includes("throw") && !src.includes("return null");
        },
      },
    ],
    timeout: 120,
  },
];

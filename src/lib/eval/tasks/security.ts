import type { EvalTask } from "../types";

/**
 * Security bug tasks — XSS vulnerabilities, injection attacks,
 * hardcoded secrets, missing input sanitization.
 */
export const securityTasks: EvalTask[] = [
  // ── SEC-001 ─────────────────────────────────────────────────────
  {
    id: "SEC-001",
    name: "XSS via dangerouslySetInnerHTML",
    description:
      "A component renders user-supplied HTML directly using " +
      "dangerouslySetInnerHTML without sanitization.",
    category: "security",
    difficulty: "medium",
    fixInstruction:
      "Fix the XSS vulnerability in src/components/Comment.tsx — it renders " +
      "user HTML via dangerouslySetInnerHTML without sanitization. Either " +
      "escape the HTML or use a sanitization library.",
    initialFiles: [
      {
        path: "src/components/Comment.tsx",
        content: `"use client";

export default function Comment({ body }: { body: string }) {
  return (
    <div
      className="comment"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
`,
      },
    ],
    expectedFiles: {
      "src/components/Comment.tsx": `"use client";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export default function Comment({ body }: { body: string }) {
  return (
    <div
      className="comment"
      dangerouslySetInnerHTML={{ __html: escapeHtml(body) }}
    />
  );
}
`,
    },
    assertions: [
      {
        label: "HTML is escaped before rendering",
        check: (files) => {
          const src = files["src/components/Comment.tsx"] || "";
          return (src.includes("escapeHtml") || src.includes("sanitize") || src.includes("DOMPurify")) &&
            src.includes("dangerouslySetInnerHTML");
        },
      },
    ],
    timeout: 120,
  },

  // ── SEC-002 ─────────────────────────────────────────────────────
  {
    id: "SEC-002",
    name: "Hardcoded API key in source",
    description:
      "An API key is hardcoded directly in the source code instead of being " +
      "read from environment variables.",
    category: "security",
    difficulty: "easy",
    fixInstruction:
      "Fix the hardcoded secret in src/services/ai.ts — the API key is " +
      "hardcoded in the source. Move it to an environment variable.",
    initialFiles: [
      {
        path: "src/services/ai.ts",
        content: `const API_KEY = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901";

export async function generateText(prompt: string): Promise<string> {
  const res = await fetch("https://api.example.com/v1/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${API_KEY}\`,
    },
    body: JSON.stringify({ prompt }),
  });
  const data = await res.json();
  return data.text;
}
`,
      },
    ],
    expectedFiles: {
      "src/services/ai.ts": `const API_KEY = process.env.AI_API_KEY;

export async function generateText(prompt: string): Promise<string> {
  if (!API_KEY) throw new Error("AI_API_KEY environment variable is not set");

  const res = await fetch("https://api.example.com/v1/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${API_KEY}\`,
    },
    body: JSON.stringify({ prompt }),
  });
  const data = await res.json();
  return data.text;
}
`,
    },
    assertions: [
      {
        label: "Uses process.env instead of hardcoded key",
        check: (files) => {
          const src = files["src/services/ai.ts"] || "";
          return src.includes("process.env") && !src.includes("sk-proj-");
        },
      },
    ],
    timeout: 120,
  },

  // ── SEC-003 ─────────────────────────────────────────────────────
  {
    id: "SEC-003",
    name: "SQL injection via string concatenation",
    description:
      "A database query is built via string concatenation instead of " +
      "parameterized queries, allowing SQL injection.",
    category: "security",
    difficulty: "medium",
    fixInstruction:
      "Fix the SQL injection vulnerability in src/services/users.ts — " +
      "the query is built with string concatenation. Use parameterized queries " +
      "or an ORM.",
    initialFiles: [
      {
        path: "src/services/users.ts",
        content: `export async function findUser(username: string) {
  const query = \`SELECT * FROM users WHERE username = '\${username}'\`;
  const result = await db.query(query);
  return result.rows[0];
}

export async function deleteUser(username: string) {
  const query = \`DELETE FROM users WHERE username = '\${username}'\`;
  await db.query(query);
}

const db = {
  async query(sql: string) {
    return { rows: [] };
  },
};
`,
      },
    ],
    expectedFiles: {
      "src/services/users.ts": `export async function findUser(username: string) {
  const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
  return result.rows[0];
}

export async function deleteUser(username: string) {
  await db.query("DELETE FROM users WHERE username = $1", [username]);
}

const db = {
  async query(sql: string, params?: unknown[]) {
    return { rows: [] };
  },
};
`,
    },
    assertions: [
      {
        label: "Uses parameterized queries ($1 placeholder)",
        check: (files) => {
          const src = files["src/services/users.ts"] || "";
          return src.includes("$1") || src.includes("?") && src.includes("params");
        },
      },
      {
        label: "No string interpolation in SQL",
        check: (files) => {
          const src = files["src/services/users.ts"] || "";
          return !src.includes("${username}'") && !src.includes("\\${username}");
        },
      },
    ],
    timeout: 120,
  },

  // ── SEC-004 ─────────────────────────────────────────────────────
  {
    id: "SEC-004",
    name: "Open redirect in callback URL",
    description:
      "An auth callback redirects to a user-supplied URL without validation, " +
      "allowing phishing attacks via open redirect.",
    category: "security",
    difficulty: "medium",
    fixInstruction:
      "Fix the open redirect vulnerability in src/app/auth/callback/route.ts — " +
      "the callback redirects to a user-supplied URL without validating it's " +
      "on the same origin.",
    initialFiles: [
      {
        path: "src/app/auth/callback/route.ts",
        content: `import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const callbackUrl = req.nextUrl.searchParams.get("callbackUrl") || "/";
  
  // Bug: redirects to any URL — open redirect vulnerability
  return NextResponse.redirect(callbackUrl);
}
`,
      },
    ],
    expectedFiles: {
      "src/app/auth/callback/route.ts": `import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const callbackUrl = req.nextUrl.searchParams.get("callbackUrl") || "/";

  // Validate that the callback URL is a relative path (same origin)
  const url = new URL(callbackUrl, req.nextUrl.origin);
  if (url.origin !== req.nextUrl.origin) {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  return NextResponse.redirect(url);
}
`,
    },
    assertions: [
      {
        label: "Validates callback URL is same-origin",
        check: (files) => {
          const src = files["src/app/auth/callback/route.ts"] || "";
          return src.includes("origin") && (src.includes("new URL") || src.includes("startsWith"));
        },
      },
    ],
    timeout: 120,
  },
];

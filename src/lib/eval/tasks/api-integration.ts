import type { EvalTask } from "../types";

/**
 * API integration bug tasks — broken HTTP calls, wrong content types,
 * missing headers, incorrect response parsing.
 */
export const apiIntegrationTasks: EvalTask[] = [
  // ── APIINT-001 ──────────────────────────────────────────────────
  {
    id: "APIINT-001",
    name: "Missing Content-Type header on POST",
    description:
      "A POST request doesn't set Content-Type: application/json, causing " +
      "the server to reject it as a 415 Unsupported Media Type.",
    category: "api-integration",
    difficulty: "easy",
    fixInstruction:
      "Fix the missing Content-Type header in src/services/api.ts — the " +
      "postJSON function doesn't set the Content-Type header.",
    initialFiles: [
      {
        path: "src/services/api.ts",
        content: `export async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    // Bug: missing Content-Type header
    body: JSON.stringify(body),
  });
  return res.json();
}
`,
      },
    ],
    expectedFiles: {
      "src/services/api.ts": `export async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}
`,
    },
    assertions: [
      {
        label: "Sets Content-Type header",
        check: (files) => {
          const src = files["src/services/api.ts"] || "";
          return src.includes("Content-Type") && src.includes("application/json");
        },
      },
    ],
    timeout: 120,
  },

  // ── APIINT-002 ──────────────────────────────────────────────────
  {
    id: "APIINT-002",
    name: "Not checking response.ok before parsing",
    description:
      "A fetch call doesn't check res.ok, so 4xx/5xx responses are parsed " +
      "as success, leading to confusing downstream errors.",
    category: "api-integration",
    difficulty: "easy",
    fixInstruction:
      "Fix the missing response check in src/services/users.ts — fetchUser " +
      "doesn't check res.ok, so error responses are silently treated as success.",
    initialFiles: [
      {
        path: "src/services/users.ts",
        content: `export async function fetchUser(id: number) {
  const res = await fetch(\`/api/users/\${id}\`);
  // Bug: no check for res.ok — 404/500 responses treated as success
  const data = await res.json();
  return data.user;
}
`,
      },
    ],
    expectedFiles: {
      "src/services/users.ts": `export async function fetchUser(id: number) {
  const res = await fetch(\`/api/users/\${id}\`);
  if (!res.ok) {
    throw new Error(\`Failed to fetch user \${id}: HTTP \${res.status}\`);
  }
  const data = await res.json();
  return data.user;
}
`,
    },
    assertions: [
      {
        label: "Checks res.ok before parsing",
        check: (files) => {
          const src = files["src/services/users.ts"] || "";
          return src.includes("res.ok") || src.includes("!res.ok");
        },
      },
    ],
    timeout: 120,
  },

  // ── APIINT-003 ──────────────────────────────────────────────────
  {
    id: "APIINT-003",
    name: "AbortController timeout not implemented",
    description:
      "A fetch call is supposed to timeout after 5 seconds but uses a " +
      "setTimeout that doesn't abort the request.",
    category: "api-integration",
    difficulty: "medium",
    fixInstruction:
      "Fix the timeout in src/services/http.ts — fetchWithTimeout creates an " +
      "AbortController but doesn't connect the setTimeout to abort it.",
    initialFiles: [
      {
        path: "src/services/http.ts",
        content: `export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = 5000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    // Bug: timeout fires but doesn't abort the controller
    console.warn("Request timed out");
  }, timeoutMs);

  const res = await fetch(url, {
    signal: controller.signal,
  });

  clearTimeout(timeout);
  return res;
}
`,
      },
    ],
    expectedFiles: {
      "src/services/http.ts": `export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = 5000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}
`,
    },
    assertions: [
      {
        label: "setTimeout calls controller.abort()",
        check: (files) => {
          const src = files["src/services/http.ts"] || "";
          return src.includes("controller.abort()");
        },
      },
    ],
    timeout: 120,
  },

  // ── APIINT-004 ──────────────────────────────────────────────────
  {
    id: "APIINT-004",
    name: "JSON parsing without error handling",
    description:
      "res.json() is called without try/catch, so malformed JSON from the " +
      "server crashes the application.",
    category: "api-integration",
    difficulty: "medium",
    fixInstruction:
      "Fix the missing error handling in src/services/config.ts — loadConfig " +
      "calls res.json() without try/catch. If the server returns non-JSON, " +
      "the app crashes.",
    initialFiles: [
      {
        path: "src/services/config.ts",
        content: `export interface AppConfig {
  apiUrl: string;
  timeout: number;
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Config fetch failed");

  // Bug: no try/catch around JSON parse
  const data = await res.json();
  return data.config;
}
`,
      },
    ],
    expectedFiles: {
      "src/services/config.ts": `export interface AppConfig {
  apiUrl: string;
  timeout: number;
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Config fetch failed");

  try {
    const data = await res.json();
    return data.config;
  } catch (error) {
    throw new Error(\`Invalid config response: \${(error as Error).message}\`);
  }
}
`,
    },
    assertions: [
      {
        label: "Has try/catch around JSON.parse",
        check: (files) => {
          const src = files["src/services/config.ts"] || "";
          return src.includes("try") && src.includes("catch");
        },
      },
    ],
    timeout: 120,
  },

  // ── APIINT-005 ──────────────────────────────────────────────────
  {
    id: "APIINT-005",
    name: "Wrong HTTP method for idempotent operation",
    description:
      "A function that should use GET (idempotent read) uses POST, causing " +
      "cache misses and wrong behavior with load balancers.",
    category: "api-integration",
    difficulty: "easy",
    fixInstruction:
      "Fix the HTTP method in src/services/status.ts — checkHealth uses POST " +
      "for a read-only health check. Change it to GET.",
    initialFiles: [
      {
        path: "src/services/status.ts",
        content: `export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", {
      method: "POST", // Bug: should be GET for a read-only check
    });
    return res.ok;
  } catch {
    return false;
  }
}
`,
      },
    ],
    expectedFiles: {
      "src/services/status.ts": `export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", {
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}
`,
    },
    assertions: [
      {
        label: "Uses GET method for health check",
        check: (files) => {
          const src = files["src/services/status.ts"] || "";
          return src.includes('method: "GET"');
        },
      },
    ],
    timeout: 120,
  },
];

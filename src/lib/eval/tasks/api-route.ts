import type { EvalTask } from "../types";

/**
 * API route bug tasks — broken Next.js API routes, missing error handling,
 * wrong HTTP methods, missing auth checks.
 */
export const apiRouteTasks: EvalTask[] = [
  // ── API-001 ─────────────────────────────────────────────────────
  {
    id: "API-001",
    name: "Missing error handling in route handler",
    description:
      "An API route crashes without returning a proper error response when " +
      "the database query fails.",
    category: "api-route",
    difficulty: "easy",
    fixInstruction:
      "Fix the error handling in src/app/api/users/route.ts — the GET handler " +
      "has no try/catch, so database errors crash the route. Add proper error " +
      "handling that returns a 500 response.",
    initialFiles: [
      {
        path: "src/app/api/users/route.ts",
        content: `import { NextResponse } from "next/server";

export async function GET() {
  const users = await fetchUsers();
  return NextResponse.json({ users });
}

async function fetchUsers() {
  // Simulates a DB call that can fail
  if (Math.random() > 0.5) throw new Error("DB connection lost");
  return [{ id: 1, name: "Alice" }];
}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/users/route.ts": `import { NextResponse } from "next/server";

export async function GET() {
  try {
    const users = await fetchUsers();
    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}

async function fetchUsers() {
  // Simulates a DB call that can fail
  if (Math.random() > 0.5) throw new Error("DB connection lost");
  return [{ id: 1, name: "Alice" }];
}
`,
    },
    assertions: [
      {
        label: "Has try/catch around fetchUsers",
        check: (files) => {
          const src = files["src/app/api/users/route.ts"] || "";
          return src.includes("try") && src.includes("catch");
        },
      },
      {
        label: "Returns 500 status on error",
        check: (files) => {
          const src = files["src/app/api/users/route.ts"] || "";
          return src.includes("status: 500") || src.includes("status:500");
        },
      },
    ],
    timeout: 120,
  },

  // ── API-002 ─────────────────────────────────────────────────────
  {
    id: "API-002",
    name: "POST handler missing input validation",
    description:
      "A POST route accepts user input without validating it, allowing " +
      "empty or malformed data to be written to the database.",
    category: "api-route",
    difficulty: "medium",
    fixInstruction:
      "Fix the input validation in src/app/api/messages/route.ts — the POST " +
      "handler doesn't validate the request body. Add validation to ensure " +
      "the body has a non-empty 'text' field and return 400 if invalid.",
    initialFiles: [
      {
        path: "src/app/api/messages/route.ts",
        content: `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  
  const message = {
    id: Date.now(),
    text: body.text,
    createdAt: new Date().toISOString(),
  };

  await saveMessage(message);
  return NextResponse.json({ success: true, message });
}

async function saveMessage(msg: any) {
  // Simulates DB save
}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/messages/route.ts": `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
      return NextResponse.json(
        { error: "text field is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    const message = {
      id: Date.now(),
      text: body.text.trim(),
      createdAt: new Date().toISOString(),
    };

    await saveMessage(message);
    return NextResponse.json({ success: true, message });
  } catch (error) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}

async function saveMessage(msg: any) {
  // Simulates DB save
}
`,
    },
    assertions: [
      {
        label: "Validates body.text exists and is non-empty",
        check: (files) => {
          const src = files["src/app/api/messages/route.ts"] || "";
          return src.includes("body.text") && (src.includes("400") || src.includes("status: 400"));
        },
      },
    ],
    timeout: 120,
  },

  // ── API-003 ─────────────────────────────────────────────────────
  {
    id: "API-003",
    name: "Route handler doesn't check HTTP method",
    description:
      "An API route exports GET but the function body also handles POST logic " +
      "without checking the method, causing wrong behavior on different methods.",
    category: "api-route",
    difficulty: "easy",
    fixInstruction:
      "Fix the HTTP method check in src/app/api/items/route.ts — the handler " +
      "should only process POST requests and return 405 for other methods.",
    initialFiles: [
      {
        path: "src/app/api/items/route.ts",
        content: `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  
  // This runs for any method, not just POST
  const item = { id: Date.now(), name: body.name };
  await saveItem(item);
  
  return NextResponse.json({ item });
}

async function saveItem(item: any) {}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/items/route.ts": `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  if (req.method !== "POST") {
    return NextResponse.json(
      { error: "Method not allowed" },
      { status: 405 }
    );
  }

  const body = await req.json();
  const item = { id: Date.now(), name: body.name };
  await saveItem(item);
  
  return NextResponse.json({ item });
}

async function saveItem(item: any) {}
`,
    },
    assertions: [
      {
        label: "Checks req.method before processing",
        check: (files) => {
          const src = files["src/app/api/items/route.ts"] || "";
          return src.includes("req.method") || src.includes("method");
        },
      },
    ],
    timeout: 120,
  },

  // ── API-004 ─────────────────────────────────────────────────────
  {
    id: "API-004",
    name: "Race condition in concurrent writes",
    description:
      "A shared counter route reads, increments, and writes without locking, " +
      "causing lost updates under concurrent requests.",
    category: "api-route",
    difficulty: "hard",
    fixInstruction:
      "Fix the race condition in src/app/api/counter/route.ts — the GET handler " +
      "reads a counter, increments it, and writes it back. Under concurrent " +
      "requests, updates are lost. Use an atomic approach.",
    initialFiles: [
      {
        path: "src/app/api/counter/route.ts",
        content: `import { NextResponse } from "next/server";

let counter = 0;

export async function GET() {
  // Race condition: read-modify-write is not atomic
  const current = counter;
  // Simulates some processing delay
  await new Promise((r) => setTimeout(r, 10));
  counter = current + 1;
  
  return NextResponse.json({ count: counter });
}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/counter/route.ts": `import { NextResponse } from "next/server";

let counter = 0;

// Simple mutex for atomic counter updates
let lock = false;
async function acquireLock() {
  while (lock) await new Promise((r) => setTimeout(r, 1));
  lock = true;
}
function releaseLock() {
  lock = false;
}

export async function GET() {
  await acquireLock();
  try {
    counter += 1;
    return NextResponse.json({ count: counter });
  } finally {
    releaseLock();
  }
}
`,
    },
    assertions: [
      {
        label: "Uses some form of locking or atomic operation",
        check: (files) => {
          const src = files["src/app/api/counter/route.ts"] || "";
          return src.includes("lock") || src.includes("mutex") || src.includes("atomic") || src.includes("await");
        },
      },
    ],
    timeout: 120,
  },

  // ── API-005 ─────────────────────────────────────────────────────
  {
    id: "API-005",
    name: "Missing CORS headers",
    description:
      "An API route doesn't set CORS headers, blocking cross-origin requests " +
      "from the frontend.",
    category: "api-route",
    difficulty: "medium",
    fixInstruction:
      "Fix the CORS issue in src/app/api/health/route.ts — the route doesn't " +
      "include CORS headers. Add proper Access-Control-Allow-Origin headers " +
      "and handle OPTIONS preflight requests.",
    initialFiles: [
      {
        path: "src/app/api/health/route.ts",
        content: `import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/health/route.ts": `import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function GET() {
  return NextResponse.json({ status: "ok" }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
`,
    },
    assertions: [
      {
        label: "Has Access-Control-Allow-Origin header",
        check: (files) => {
          const src = files["src/app/api/health/route.ts"] || "";
          return src.includes("Access-Control-Allow-Origin");
        },
      },
      {
        label: "Handles OPTIONS preflight",
        check: (files) => {
          const src = files["src/app/api/health/route.ts"] || "";
          return src.includes("OPTIONS");
        },
      },
    ],
    timeout: 120,
  },

  // ── API-006 ─────────────────────────────────────────────────────
  {
    id: "API-006",
    name: "Request body consumed twice",
    description:
      "An API route calls req.json() twice, which throws on the second call " +
      "because the body stream has already been consumed.",
    category: "api-route",
    difficulty: "medium",
    fixInstruction:
      "Fix the double-consume bug in src/app/api/process/route.ts — the route " +
      "calls req.json() twice which fails on the second call. Parse once and " +
      "reuse the result.",
    initialFiles: [
      {
        path: "src/app/api/process/route.ts",
        content: `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body1 = await req.json();
  
  // Validate
  const body2 = await req.json(); // Bug: body already consumed
  if (!body2.action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  return NextResponse.json({ processed: body1 });
}
`,
      },
    ],
    expectedFiles: {
      "src/app/api/process/route.ts": `import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (!body.action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  return NextResponse.json({ processed: body });
}
`,
    },
    assertions: [
      {
        label: "Only calls req.json() once",
        check: (files) => {
          const src = files["src/app/api/process/route.ts"] || "";
          const matches = src.match(/req\.json\(\)/g);
          return matches !== null && matches.length === 1;
        },
      },
    ],
    timeout: 120,
  },
];

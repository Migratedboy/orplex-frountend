import type { EvalTask } from "../types";

/**
 * Logic bug tasks — the code compiles but behaves incorrectly at runtime.
 * The agent must identify and fix the logical error.
 */
export const logicBugTasks: EvalTask[] = [
  // ── LOGIC-001 ───────────────────────────────────────────────────
  {
    id: "LOGIC-001",
    name: "Off-by-one in array slicing",
    description:
      "A pagination function slices the array with wrong indices, returning " +
      "one fewer item than expected on pages after the first.",
    category: "logic-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the bug in src/utils/paginate.ts — the paginate function returns " +
      "one fewer item than expected. The slice indices are wrong.",
    initialFiles: [
      {
        path: "src/utils/paginate.ts",
        content:
          "export function paginate<T>(\n" +
          "  items: T[],\n" +
          "  page: number,\n" +
          "  pageSize: number\n" +
          "): { items: T[]; total: number; totalPages: number } {\n" +
          "  const totalPages = Math.ceil(items.length / pageSize);\n" +
          "  const start = (page - 1) * pageSize;\n" +
          "  const end = start + pageSize;\n" +
          "  return {\n" +
          "    items: items.slice(start, end - 1),\n" +
          "    total: items.length,\n" +
          "    totalPages,\n" +
          "  };\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/paginate.ts":
        "export function paginate<T>(\n" +
        "  items: T[],\n" +
        "  page: number,\n" +
        "  pageSize: number\n" +
        "): { items: T[]; total: number; totalPages: number } {\n" +
        "  const totalPages = Math.ceil(items.length / pageSize);\n" +
        "  const start = (page - 1) * pageSize;\n" +
        "  const end = start + pageSize;\n" +
        "  return {\n" +
        "    items: items.slice(start, end),\n" +
        "    total: items.length,\n" +
        "    totalPages,\n" +
        "  };\n" +
        "}\n",
    },
    assertions: [
      {
        label: "slice end is not decremented",
        check: (files) => {
          const src = files["src/utils/paginate.ts"] || "";
          return src.includes("slice(start, end)") && !src.includes("slice(start, end - 1)");
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-002 ───────────────────────────────────────────────────
  {
    id: "LOGIC-002",
    name: "Incorrect regex for email validation",
    description:
      "A regex that's supposed to validate emails accepts invalid inputs " +
      "like 'user@' and rejects valid ones like 'user+tag@domain.com'.",
    category: "logic-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the email validation regex in src/utils/validate.ts — it accepts " +
      "invalid emails like 'user@' and rejects valid ones with plus addresses.",
    initialFiles: [
      {
        path: "src/utils/validate.ts",
        content:
          'const EMAIL_REGEX = /^[^\\s@]+@[^\\s@]*$/;\n' +
          "\n" +
          "export function isValidEmail(email: string): boolean {\n" +
          "  return EMAIL_REGEX.test(email);\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/validate.ts":
        'const EMAIL_REGEX = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\n' +
        "\n" +
        "export function isValidEmail(email: string): boolean {\n" +
        "  return EMAIL_REGEX.test(email);\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Regex requires domain with dot",
        check: (files) => {
          const src = files["src/utils/validate.ts"] || "";
          return /\.\[?\^?\\s@/.test(src) || src.includes("\\.[^\\s@]+");
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-003 ───────────────────────────────────────────────────
  {
    id: "LOGIC-003",
    name: "Promise not awaited in fire-and-forget",
    description:
      "An async operation is called without await, so errors are silently " +
      "swallowed and the function returns before the operation completes.",
    category: "logic-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the bug in src/services/logger.ts — logAudit calls writeLog without " +
      "awaiting it. The function returns before the log is written, and errors " +
      "are silently lost. Await the call and handle errors.",
    initialFiles: [
      {
        path: "src/services/logger.ts",
        content:
          'export async function logAudit(action: string, userId: string): Promise<void> {\n' +
          "  const entry = JSON.stringify({ action, userId, timestamp: Date.now() });\n" +
          "  writeLog(entry);\n" +
          '  console.log("Audit logged");\n' +
          "}\n" +
          "\n" +
          "async function writeLog(entry: string): Promise<void> {\n" +
          "  // Simulates writing to a log file\n" +
          "  await new Promise((resolve) => setTimeout(resolve, 10));\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/services/logger.ts":
        'export async function logAudit(action: string, userId: string): Promise<void> {\n' +
        "  const entry = JSON.stringify({ action, userId, timestamp: Date.now() });\n" +
        "  await writeLog(entry);\n" +
        '  console.log("Audit logged");\n' +
        "}\n" +
        "\n" +
        "async function writeLog(entry: string): Promise<void> {\n" +
        "  // Simulates writing to a log file\n" +
        "  await new Promise((resolve) => setTimeout(resolve, 10));\n" +
        "}\n",
    },
    assertions: [
      {
        label: "writeLog is awaited",
        check: (files) => {
          const src = files["src/services/logger.ts"] || "";
          return src.includes("await writeLog");
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-004 ───────────────────────────────────────────────────
  {
    id: "LOGIC-004",
    name: "Deep clone loses prototype",
    description:
      "A deep clone function uses JSON.parse(JSON.stringify()) which loses " +
      "Date objects, turning them into strings.",
    category: "logic-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the deep clone function in src/utils/clone.ts — it uses " +
      "JSON.parse(JSON.stringify()) which converts Date objects to strings. " +
      "Use structuredClone or a custom replacer/reviver.",
    initialFiles: [
      {
        path: "src/utils/clone.ts",
        content:
          "export function deepClone<T>(obj: T): T {\n" +
          "  return JSON.parse(JSON.stringify(obj));\n" +
          "}\n" +
          "\n" +
          '// Usage - fails because dates become strings\n' +
          'const original = { name: "test", createdAt: new Date("2024-01-01") };\n' +
          "const cloned = deepClone(original);\n" +
          "// cloned.createdAt is a string, not a Date!\n" +
          "console.log(cloned.createdAt instanceof Date); // false\n",
      },
    ],
    expectedFiles: {
      "src/utils/clone.ts":
        "export function deepClone<T>(obj: T): T {\n" +
        "  return structuredClone(obj);\n" +
        "}\n" +
        "\n" +
        '// Usage - fails because dates become strings\n' +
        'const original = { name: "test", createdAt: new Date("2024-01-01") };\n' +
        "const cloned = deepClone(original);\n" +
        "// cloned.createdAt is a string, not a Date!\n" +
        "console.log(cloned.createdAt instanceof Date); // false\n",
    },
    assertions: [
      {
        label: "Uses structuredClone or custom reviver for Dates",
        check: (files) => {
          const src = files["src/utils/clone.ts"] || "";
          return src.includes("structuredClone") || src.includes("Date.parse") || src.includes("reviver");
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-005 ───────────────────────────────────────────────────
  {
    id: "LOGIC-005",
    name: "Race condition in state setter",
    description:
      "A React component uses a stale closure when updating state based on " +
      "previous state, causing lost updates.",
    category: "logic-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the race condition in src/components/Counter.tsx — the increment " +
      "function reads count from a stale closure instead of using the functional " +
      "state update form.",
    initialFiles: [
      {
        path: "src/components/Counter.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { useState } from "react";\n' +
          "\n" +
          "export default function Counter() {\n" +
          "  const [count, setCount] = useState(0);\n" +
          "\n" +
          "  const increment = () => {\n" +
          "    // Bug: uses stale count from closure\n" +
          "    setCount(count + 1);\n" +
          "  };\n" +
          "\n" +
          "  const incrementMultiple = () => {\n" +
          "    // Calls increment 3 times - only adds 1 instead of 3\n" +
          "    increment();\n" +
          "    increment();\n" +
          "    increment();\n" +
          "  };\n" +
          "\n" +
          "  return (\n" +
          "    <div>\n" +
          "      <p>Count: {count}</p>\n" +
          '      <button onClick={increment}>+1</button>\n' +
          '      <button onClick={incrementMultiple}>+3</button>\n' +
          "    </div>\n" +
          "  );\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/Counter.tsx":
        '"use client";\n' +
        "\n" +
        'import { useState } from "react";\n' +
        "\n" +
        "export default function Counter() {\n" +
        "  const [count, setCount] = useState(0);\n" +
        "\n" +
        "  const increment = () => {\n" +
        "    setCount((prev) => prev + 1);\n" +
        "  };\n" +
        "\n" +
        "  const incrementMultiple = () => {\n" +
        "    // Calls increment 3 times - only adds 1 instead of 3\n" +
        "    increment();\n" +
        "    increment();\n" +
        "    increment();\n" +
        "  };\n" +
        "\n" +
        "  return (\n" +
        "    <div>\n" +
        "      <p>Count: {count}</p>\n" +
        '      <button onClick={increment}>+1</button>\n' +
        '      <button onClick={incrementMultiple}>+3</button>\n' +
        "    </div>\n" +
        "  );\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses functional state update (prev => prev + 1)",
        check: (files) => {
          const src = files["src/components/Counter.tsx"] || "";
          return src.includes("prev") && (src.includes("prev + 1") || src.includes("prev)=>prev+1") || src.includes("(prev) => prev + 1"));
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-006 ───────────────────────────────────────────────────
  {
    id: "LOGIC-006",
    name: "Incorrect sort comparator",
    description:
      "An array sort uses subtraction which doesn't work correctly for " +
      "strings or when values can be negative.",
    category: "logic-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the sort comparator in src/utils/sort.ts — the sort function uses " +
      "a - b which only works for numbers. Make it handle strings correctly.",
    initialFiles: [
      {
        path: "src/utils/sort.ts",
        content:
          "export function sortItems<T extends { name: string; priority: number }>(\n" +
          "  items: T[]\n" +
          "): T[] {\n" +
          "  return [...items].sort((a, b) => a.name - b.name);\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/sort.ts":
        "export function sortItems<T extends { name: string; priority: number }>(\n" +
        "  items: T[]\n" +
        "): T[] {\n" +
        "  return [...items].sort((a, b) => a.name.localeCompare(b.name));\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses localeCompare for string sorting",
        check: (files) => {
          const src = files["src/utils/sort.ts"] || "";
          return src.includes("localeCompare");
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-007 ───────────────────────────────────────────────────
  {
    id: "LOGIC-007",
    name: "Missing early return in guard clause",
    description:
      "A function has a guard clause that should return early but doesn't, " +
      "causing it to fall through to code that assumes the guard passed.",
    category: "logic-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the bug in src/utils/sanitize.ts — the sanitize function checks if " +
      "input is empty but doesn't return early, so it continues processing " +
      "and returns undefined.",
    initialFiles: [
      {
        path: "src/utils/sanitize.ts",
        content:
          "export function sanitize(input: string | null | undefined): string {\n" +
          "  if (!input) {\n" +
          '    console.warn("Empty input provided to sanitize");\n' +
          "  }\n" +
          "\n" +
          "  const trimmed = input.trim();\n" +
          "  return trimmed\n" +
          '    .replace(/&/g, "&amp;")\n' +
          '    .replace(/</g, "&lt;")\n' +
          '    .replace(/>/g, "&gt;");\n' +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/sanitize.ts":
        "export function sanitize(input: string | null | undefined): string {\n" +
        "  if (!input) {\n" +
        '    console.warn("Empty input provided to sanitize");\n' +
        '    return "";\n' +
        "  }\n" +
        "\n" +
        "  const trimmed = input.trim();\n" +
        "  return trimmed\n" +
        '    .replace(/&/g, "&amp;")\n' +
        '    .replace(/</g, "&lt;")\n' +
        '    .replace(/>/g, "&gt;");\n' +
        "}\n",
    },
    assertions: [
      {
        label: "Early return with empty string for falsy input",
        check: (files) => {
          const src = files["src/utils/sanitize.ts"] || "";
          return src.includes('return ""');
        },
      },
    ],
    timeout: 120,
  },

  // ── LOGIC-008 ───────────────────────────────────────────────────
  {
    id: "LOGIC-008",
    name: "Mutating input parameter",
    description:
      "A function modifies its input array instead of working on a copy, " +
      "causing unexpected side effects for callers.",
    category: "logic-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the bug in src/utils/deduplicate.ts — the deduplicate function " +
      "mutates the input array by calling splice on it. Work on a copy instead.",
    initialFiles: [
      {
        path: "src/utils/deduplicate.ts",
        content:
          "export function deduplicate<T extends { id: string }>(\n" +
          "  items: T[]\n" +
          "): T[] {\n" +
          "  const seen = new Set<string>();\n" +
          "  for (let i = items.length - 1; i >= 0; i--) {\n" +
          "    if (seen.has(items[i].id)) {\n" +
          "      items.splice(i, 1);\n" +
          "    } else {\n" +
          "      seen.add(items[i].id);\n" +
          "    }\n" +
          "  }\n" +
          "  return items;\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/deduplicate.ts":
        "export function deduplicate<T extends { id: string }>(\n" +
        "  items: T[]\n" +
        "): T[] {\n" +
        "  const seen = new Set<string>();\n" +
        "  const result: T[] = [];\n" +
        "  for (const item of items) {\n" +
        "    if (!seen.has(item.id)) {\n" +
        "      seen.add(item.id);\n" +
        "      result.push(item);\n" +
        "    }\n" +
        "  }\n" +
        "  return result;\n" +
        "}\n",
    },
    assertions: [
      {
        label: "No splice on input array",
        check: (files) => {
          const src = files["src/utils/deduplicate.ts"] || "";
          return !src.includes("items.splice");
        },
      },
      {
        label: "Returns a new array",
        check: (files) => {
          const src = files["src/utils/deduplicate.ts"] || "";
          return src.includes("result") || src.includes("[...");
        },
      },
    ],
    timeout: 120,
  },
];

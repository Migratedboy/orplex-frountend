import type { EvalTask } from "../types";

/**
 * Performance bug tasks — N+1 queries, unnecessary re-renders,
 * missing memoization, inefficient algorithms.
 */
export const performanceTasks: EvalTask[] = [
  // ── PERF-001 ────────────────────────────────────────────────────
  {
    id: "PERF-001",
    name: "N+1 query in user loader",
    description:
      "A function loads users then makes a separate query for each user's " +
      "posts, causing N+1 database queries.",
    category: "performance",
    difficulty: "medium",
    fixInstruction:
      "Fix the N+1 query problem in src/services/user-loader.ts — loadUsersWithPosts " +
      "fetches all users, then loops to fetch posts per user. Use a JOIN or " +
      "batch query instead.",
    initialFiles: [
      {
        path: "src/services/user-loader.ts",
        content:
          "interface User {\n" +
          "  id: number;\n" +
          "  name: string;\n" +
          "}\n" +
          "\n" +
          "interface Post {\n" +
          "  id: number;\n" +
          "  userId: number;\n" +
          "  title: string;\n" +
          "}\n" +
          "\n" +
          "interface UserWithPosts extends User {\n" +
          "  posts: Post[];\n" +
          "}\n" +
          "\n" +
          "const db = {\n" +
          "  async query(sql: string) { return { rows: [] as any[] }; },\n" +
          "};\n" +
          "\n" +
          "export async function loadUsersWithPosts(): Promise<UserWithPosts[]> {\n" +
          '  const { rows: users } = await db.query("SELECT * FROM users");\n' +
          "\n" +
          "  const result: UserWithPosts[] = [];\n" +
          "  for (const user of users) {\n" +
          "    // N+1: one query per user\n" +
          "    const { rows: posts } = await db.query(\n" +
          "      `SELECT * FROM posts WHERE userId = ${user.id}`\n" +
          "    );\n" +
          "    result.push({ ...user, posts });\n" +
          "  }\n" +
          "  return result;\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/services/user-loader.ts":
        "interface User {\n" +
        "  id: number;\n" +
        "  name: string;\n" +
        "}\n" +
        "\n" +
        "interface Post {\n" +
        "  id: number;\n" +
        "  userId: number;\n" +
        "  title: string;\n" +
        "}\n" +
        "\n" +
        "interface UserWithPosts extends User {\n" +
        "  posts: Post[];\n" +
        "}\n" +
        "\n" +
        "const db = {\n" +
        "  async query(sql: string, params?: unknown[]) { return { rows: [] as any[] }; },\n" +
        "};\n" +
        "\n" +
        "export async function loadUsersWithPosts(): Promise<UserWithPosts[]> {\n" +
        "  const { rows } = await db.query(\n" +
        "    `SELECT u.*, p.id as post_id, p.title as post_title, p.userId as post_userId\n" +
        "     FROM users u\n" +
        "     LEFT JOIN posts p ON p.userId = u.id`\n" +
        "  );\n" +
        "\n" +
        "  const userMap = new Map<number, UserWithPosts>();\n" +
        "  for (const row of rows) {\n" +
        "    if (!userMap.has(row.id)) {\n" +
        "      userMap.set(row.id, { id: row.id, name: row.name, posts: [] });\n" +
        "    }\n" +
        "    if (row.post_id) {\n" +
        "      userMap.get(row.id)!.posts.push({\n" +
        "        id: row.post_id,\n" +
        "        userId: row.post_userId,\n" +
        "        title: row.post_title,\n" +
        "      });\n" +
        "    }\n" +
        "  }\n" +
        "  return Array.from(userMap.values());\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses a single JOIN query instead of N+1",
        check: (files) => {
          const src = files["src/services/user-loader.ts"] || "";
          return src.toLowerCase().includes("join") && !src.includes("for (const user of users)");
        },
      },
    ],
    timeout: 120,
  },

  // ── PERF-002 ────────────────────────────────────────────────────
  {
    id: "PERF-002",
    name: "Expensive computation in render",
    description:
      "A component computes a sorted/filtered list on every render without " +
      "memoization, causing jank on large datasets.",
    category: "performance",
    difficulty: "medium",
    fixInstruction:
      "Fix the performance issue in src/components/ProductList.tsx — the " +
      "filtered and sorted list is computed on every render. Use useMemo " +
      "to memoize the computation.",
    initialFiles: [
      {
        path: "src/components/ProductList.tsx",
        content:
          '"use client";\n' +
          "\n" +
          "interface Product {\n" +
          "  id: number;\n" +
          "  name: string;\n" +
          "  price: number;\n" +
          "  inStock: boolean;\n" +
          "}\n" +
          "\n" +
          "export default function ProductList({\n" +
          "  products,\n" +
          "  minPrice,\n" +
          "}: {\n" +
          "  products: Product[];\n" +
          "  minPrice: number;\n" +
          "}) {\n" +
          "  // Bug: expensive sort+filter runs every render\n" +
          "  const visible = products\n" +
          "    .filter((p) => p.inStock && p.price >= minPrice)\n" +
          "    .sort((a, b) => a.price - b.price);\n" +
          "\n" +
          "  return (\n" +
          "    <ul>\n" +
          "      {visible.map((p) => (\n" +
          "        <li key={p.id}>{p.name} - {p.price}</li>\n" +
          "      ))}\n" +
          "    </ul>\n" +
          "  );\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/ProductList.tsx":
        '"use client";\n' +
        "\n" +
        'import { useMemo } from "react";\n' +
        "\n" +
        "interface Product {\n" +
        "  id: number;\n" +
        "  name: string;\n" +
        "  price: number;\n" +
        "  inStock: boolean;\n" +
        "}\n" +
        "\n" +
        "export default function ProductList({\n" +
        "  products,\n" +
        "  minPrice,\n" +
        "}: {\n" +
        "  products: Product[];\n" +
        "  minPrice: number;\n" +
        "}) {\n" +
        "  const visible = useMemo(\n" +
        "    () =>\n" +
        "      products\n" +
        "        .filter((p) => p.inStock && p.price >= minPrice)\n" +
        "        .sort((a, b) => a.price - b.price),\n" +
        "    [products, minPrice]\n" +
        "  );\n" +
        "\n" +
        "  return (\n" +
        "    <ul>\n" +
        "      {visible.map((p) => (\n" +
        "        <li key={p.id}>{p.name} - {p.price}</li>\n" +
        "      ))}\n" +
        "    </ul>\n" +
        "  );\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses useMemo for expensive computation",
        check: (files) => {
          const src = files["src/components/ProductList.tsx"] || "";
          return src.includes("useMemo");
        },
      },
    ],
    timeout: 120,
  },

  // ── PERF-003 ────────────────────────────────────────────────────
  {
    id: "PERF-003",
    name: "Inefficient string concatenation in loop",
    description:
      "A function builds a large string using += in a loop instead of " +
      "using array.join(), causing O(n²) performance.",
    category: "performance",
    difficulty: "easy",
    fixInstruction:
      "Fix the O(n²) string building in src/utils/csv.ts — buildCsv uses " +
      "string concatenation in a loop. Use Array.join() instead.",
    initialFiles: [
      {
        path: "src/utils/csv.ts",
        content:
          "export function buildCsv(rows: string[][]): string {\n" +
          '  let result = "";\n' +
          "  for (const row of rows) {\n" +
          "    for (let i = 0; i < row.length; i++) {\n" +
          "      result += row[i];\n" +
          "      if (i < row.length - 1) result += \",\";\n" +
          "    }\n" +
          '    result += "\\n";\n' +
          "  }\n" +
          "  return result;\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/utils/csv.ts":
        "export function buildCsv(rows: string[][]): string {\n" +
        "  return rows.map((row) => row.join(\",\")).join(\"\\n\");\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses join() instead of string concatenation",
        check: (files) => {
          const src = files["src/utils/csv.ts"] || "";
          return src.includes("join") && !src.includes("result +=");
        },
      },
    ],
    timeout: 120,
  },
];

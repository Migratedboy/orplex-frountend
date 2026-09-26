import type { EvalTask } from "../types";
import { apiFetch } from "@/lib/api-base";

/**
 * React component bug tasks — incorrect hooks usage, render bugs,
 * stale closures, missing dependencies, and wrong key usage.
 */
export const reactBugTasks: EvalTask[] = [
  // ── REACT-001 ───────────────────────────────────────────────────
  {
    id: "REACT-001",
    name: "Missing useEffect dependency",
    description:
      "A useEffect that fetches data on mount doesn't list its dependencies, " +
      "causing a stale closure and ESLint react-hooks/exhaustive-deps warning.",
    category: "react-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the missing dependency in src/components/UserList.tsx — the useEffect " +
      "fetches data using the `page` state but doesn't list it as a dependency.",
    initialFiles: [
      {
        path: "src/components/UserList.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { useState, useEffect } from "react";\n' +
          "\n" +
          "export default function UserList() {\n" +
          '  const [users, setUsers] = useState<string[]>([]);\n' +
          "  const [page, setPage] = useState(1);\n" +
          "\n" +
          "  useEffect(() => {\n" +
          "    apiFetch(`/api/users?page=${page}`)\n" +
          '      .then((r) => r.json())\n' +
          "      .then((d) => setUsers(d.users));\n" +
          "  }, []); // Missing `page` dependency\n" +
          "\n" +
          "  return (\n" +
          "    <div>\n" +
          "      {users.map((u) => <div key={u}>{u}</div>)}\n" +
          '      <button onClick={() => setPage(page + 1)}>Next</button>\n' +
          "    </div>\n" +
          "  );\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/UserList.tsx":
        '"use client";\n' +
        "\n" +
        'import { useState, useEffect } from "react";\n' +
        "\n" +
        "export default function UserList() {\n" +
        '  const [users, setUsers] = useState<string[]>([]);\n' +
        "  const [page, setPage] = useState(1);\n" +
        "\n" +
        "  useEffect(() => {\n" +
        "    apiFetch(`/api/users?page=${page}`)\n" +
        '      .then((r) => r.json())\n' +
        "      .then((d) => setUsers(d.users));\n" +
        "  }, [page]);\n" +
        "\n" +
        "  return (\n" +
        "    <div>\n" +
        "      {users.map((u) => <div key={u}>{u}</div>)}\n" +
        '      <button onClick={() => setPage(page + 1)}>Next</button>\n' +
        "    </div>\n" +
        "  );\n" +
        "}\n",
    },
    assertions: [
      {
        label: "page listed in useEffect dependency array",
        check: (files) => {
          const src = files["src/components/UserList.tsx"] || "";
          return src.includes("[page]");
        },
      },
    ],
    timeout: 120,
  },

  // ── REACT-002 ───────────────────────────────────────────────────
  {
    id: "REACT-002",
    name: "Using index as key with reorderable list",
    description:
      "A list component uses array index as key, but the list can be reordered " +
      "or filtered, causing incorrect DOM reconciliation.",
    category: "react-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the key prop in src/components/TodoList.tsx — it uses index as the key " +
      "but the list items have unique IDs. Use the item's ID instead.",
    initialFiles: [
      {
        path: "src/components/TodoList.tsx",
        content:
          '"use client";\n' +
          "\n" +
          "interface Todo {\n" +
          "  id: string;\n" +
          "  text: string;\n" +
          "  done: boolean;\n" +
          "}\n" +
          "\n" +
          "export default function TodoList({ items }: { items: Todo[] }) {\n" +
          "  return (\n" +
          "    <ul>\n" +
          "      {items.map((item, index) => (\n" +
          "        <li key={index}>\n" +
          '          <span style={{ textDecoration: item.done ? "line-through" : "none" }}>\n' +
          "            {item.text}\n" +
          "          </span>\n" +
          "        </li>\n" +
          "      ))}\n" +
          "    </ul>\n" +
          "  );\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/TodoList.tsx":
        '"use client";\n' +
        "\n" +
        "interface Todo {\n" +
        "  id: string;\n" +
        "  text: string;\n" +
        "  done: boolean;\n" +
        "}\n" +
        "\n" +
        "export default function TodoList({ items }: { items: Todo[] }) {\n" +
        "  return (\n" +
        "    <ul>\n" +
        "      {items.map((item) => (\n" +
        "        <li key={item.id}>\n" +
        '          <span style={{ textDecoration: item.done ? "line-through" : "none" }}>\n' +
        "            {item.text}\n" +
        "          </span>\n" +
        "        </li>\n" +
        "      ))}\n" +
        "    </ul>\n" +
        "  );\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses item.id as key, not index",
        check: (files) => {
          const src = files["src/components/TodoList.tsx"] || "";
          return src.includes("key={item.id}") && !src.includes("key={index}");
        },
      },
    ],
    timeout: 120,
  },

  // ── REACT-003 ───────────────────────────────────────────────────
  {
    id: "REACT-003",
    name: "useEffect cleanup missing for subscription",
    description:
      "A useEffect subscribes to an event emitter but doesn't return a cleanup " +
      "function, causing memory leaks on unmount.",
    category: "react-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the memory leak in src/components/EventListener.tsx — the useEffect " +
      "subscribes to an event emitter but doesn't return a cleanup function to " +
      "unsubscribe on unmount.",
    initialFiles: [
      {
        path: "src/components/EventListener.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { useState, useEffect } from "react";\n' +
          "\n" +
          "const emitter = {\n" +
          "  listeners: new Map<string, Set<(data: any) => void>>(),\n" +
          "  on(event: string, fn: (data: any) => void) {\n" +
          "    if (!this.listeners.has(event)) this.listeners.set(event, new Set());\n" +
          "    this.listeners.get(event)!.add(fn);\n" +
          "  },\n" +
          "  off(event: string, fn: (data: any) => void) {\n" +
          "    this.listeners.get(event)?.delete(fn);\n" +
          "  },\n" +
          "  emit(event: string, data: any) {\n" +
          "    this.listeners.get(event)?.forEach((fn) => fn(data));\n" +
          "  },\n" +
          "};\n" +
          "\n" +
          "export default function EventListener() {\n" +
          '  const [lastEvent, setLastEvent] = useState("");\n' +
          "\n" +
          "  useEffect(() => {\n" +
          "    const handler = (data: any) => setLastEvent(JSON.stringify(data));\n" +
          '    emitter.on("update", handler);\n' +
          "    // Bug: no cleanup - leaks on unmount\n" +
          "  }, []);\n" +
          "\n" +
          "  return <div>Last event: {lastEvent}</div>;\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/EventListener.tsx":
        '"use client";\n' +
        "\n" +
        'import { useState, useEffect } from "react";\n' +
        "\n" +
        "const emitter = {\n" +
        "  listeners: new Map<string, Set<(data: any) => void>>(),\n" +
        "  on(event: string, fn: (data: any) => void) {\n" +
        "    if (!this.listeners.has(event)) this.listeners.set(event, new Set());\n" +
        "    this.listeners.get(event)!.add(fn);\n" +
        "  },\n" +
        "  off(event: string, fn: (data: any) => void) {\n" +
        "    this.listeners.get(event)?.delete(fn);\n" +
        "  },\n" +
        "  emit(event: string, data: any) {\n" +
        "    this.listeners.get(event)?.forEach((fn) => fn(data));\n" +
        "  },\n" +
        "};\n" +
        "\n" +
        "export default function EventListener() {\n" +
        '  const [lastEvent, setLastEvent] = useState("");\n' +
        "\n" +
        "  useEffect(() => {\n" +
        "    const handler = (data: any) => setLastEvent(JSON.stringify(data));\n" +
        '    emitter.on("update", handler);\n' +
        "    return () => {\n" +
        '      emitter.off("update", handler);\n' +
        "    };\n" +
        "  }, []);\n" +
        "\n" +
        "  return <div>Last event: {lastEvent}</div>;\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Returns cleanup function from useEffect",
        check: (files) => {
          const src = files["src/components/EventListener.tsx"] || "";
          return src.includes("return () =>") || src.includes("return()=>");
        },
      },
    ],
    timeout: 120,
  },

  // ── REACT-004 ───────────────────────────────────────────────────
  {
    id: "REACT-004",
    name: "Conditional hook call",
    description:
      "A hook is called inside a conditional branch, violating the Rules of Hooks.",
    category: "react-bug",
    difficulty: "medium",
    fixInstruction:
      "Fix the Rules of Hooks violation in src/components/SearchBox.tsx — " +
      "useEffect is called inside an if statement. Move it outside the conditional.",
    initialFiles: [
      {
        path: "src/components/SearchBox.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { useState, useEffect } from "react";\n' +
          "\n" +
          'export default function SearchBox({ onSearch }: { onSearch: (q: string) => void }) {\n' +
          "  const [query, setQuery] = useState(\"\");\n" +
          '  const [debouncedQuery, setDebouncedQuery] = useState("");\n' +
          "\n" +
          "  if (query.length > 2) {\n" +
          "    useEffect(() => {\n" +
          "      const timer = setTimeout(() => setDebouncedQuery(query), 300);\n" +
          "      return () => clearTimeout(timer);\n" +
          "    }, [query]);\n" +
          "  }\n" +
          "\n" +
          "  useEffect(() => {\n" +
          "    if (debouncedQuery) onSearch(debouncedQuery);\n" +
          "  }, [debouncedQuery, onSearch]);\n" +
          "\n" +
          '  return <input value={query} onChange={(e) => setQuery(e.target.value)} />;\n' +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/SearchBox.tsx":
        '"use client";\n' +
        "\n" +
        'import { useState, useEffect } from "react";\n' +
        "\n" +
        'export default function SearchBox({ onSearch }: { onSearch: (q: string) => void }) {\n' +
        "  const [query, setQuery] = useState(\"\");\n" +
        '  const [debouncedQuery, setDebouncedQuery] = useState("");\n' +
        "\n" +
        "  useEffect(() => {\n" +
        "    if (query.length <= 2) return;\n" +
        "    const timer = setTimeout(() => setDebouncedQuery(query), 300);\n" +
        "    return () => clearTimeout(timer);\n" +
        "  }, [query]);\n" +
        "\n" +
        "  useEffect(() => {\n" +
        "    if (debouncedQuery) onSearch(debouncedQuery);\n" +
        "  }, [debouncedQuery, onSearch]);\n" +
        "\n" +
        '  return <input value={query} onChange={(e) => setQuery(e.target.value)} />;\n' +
        "}\n",
    },
    assertions: [
      {
        label: "useEffect is not inside an if block",
        check: (files) => {
          const src = files["src/components/SearchBox.tsx"] || "";
          const lines = src.split("\n");
          const effectIdx = lines.findIndex((l) => l.includes("useEffect(() =>"));
          if (effectIdx === -1) return false;
          const prevLine = lines[effectIdx - 1]?.trim() || "";
          return !prevLine.startsWith("if (");
        },
      },
    ],
    timeout: 120,
  },

  // ── REACT-005 ───────────────────────────────────────────────────
  {
    id: "REACT-005",
    name: "Incorrect boolean state toggle",
    description:
      "A toggle function sets state to a boolean literal instead of using " +
      "a functional updater, which works but is semantically wrong.",
    category: "react-bug",
    difficulty: "easy",
    fixInstruction:
      "Fix the toggle function in src/components/Toggle.tsx — it should use " +
      "a functional state updater instead of a static boolean value.",
    initialFiles: [
      {
        path: "src/components/Toggle.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { useState } from "react";\n' +
          "\n" +
          "export default function Toggle() {\n" +
          "  const [isOn, setIsOn] = useState(false);\n" +
          "\n" +
          "  const toggle = () => {\n" +
          "    setIsOn(true); // Bug: always sets to true, never toggles\n" +
          "  };\n" +
          "\n" +
          "  return (\n" +
          '    <button onClick={toggle}>\n' +
          '      {isOn ? "ON" : "OFF"}\n' +
          "    </button>\n" +
          "  );\n" +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/Toggle.tsx":
        '"use client";\n' +
        "\n" +
        'import { useState } from "react";\n' +
        "\n" +
        "export default function Toggle() {\n" +
        "  const [isOn, setIsOn] = useState(false);\n" +
        "\n" +
        "  const toggle = () => {\n" +
        "    setIsOn((prev) => !prev);\n" +
        "  };\n" +
        "\n" +
        "  return (\n" +
        '    <button onClick={toggle}>\n' +
        '      {isOn ? "ON" : "OFF"}\n' +
        "    </button>\n" +
        "  );\n" +
        "}\n",
    },
    assertions: [
      {
        label: "Uses functional updater for toggle",
        check: (files) => {
          const src = files["src/components/Toggle.tsx"] || "";
          return (src.includes("prev => !prev") || src.includes("prev)=>!prev") || src.includes("!prev"));
        },
      },
    ],
    timeout: 120,
  },

  // ── REACT-006 ───────────────────────────────────────────────────
  {
    id: "REACT-006",
    name: "Memoized component re-renders unnecessarily",
    description:
      "A component is wrapped in React.memo but passes a new object/array " +
      "as props on every render, defeating memoization.",
    category: "react-bug",
    difficulty: "hard",
    fixInstruction:
      "Fix the unnecessary re-renders in src/components/ExpensiveList.tsx — " +
      "the parent creates a new filterConfig object on every render. Use useMemo " +
      "to stabilize the config object.",
    initialFiles: [
      {
        path: "src/components/ExpensiveList.tsx",
        content:
          '"use client";\n' +
          "\n" +
          'import { memo } from "react";\n' +
          "\n" +
          "interface FilterConfig {\n" +
          "  minPrice: number;\n" +
          "  maxPrice: number;\n" +
          "  inStock: boolean;\n" +
          "}\n" +
          "\n" +
          "const ExpensiveList = memo(function ExpensiveList({\n" +
          "  items,\n" +
          "  filter,\n" +
          "}: {\n" +
          "  items: string[];\n" +
          "  filter: FilterConfig;\n" +
          "}) {\n" +
          '  console.log("ExpensiveList rendered");\n' +
          "  return (\n" +
          "    <ul>\n" +
          "      {items.map((item) => (\n" +
          "        <li key={item}>{item}</li>\n" +
          "      ))}\n" +
          "    </ul>\n" +
          "  );\n" +
          "});\n" +
          "\n" +
          "export default function Parent() {\n" +
          "  // Bug: new object every render defeats memo\n" +
          '  const filterConfig = { minPrice: 0, maxPrice: 100, inStock: true };\n' +
          "\n" +
          '  return <ExpensiveList items={["a", "b", "c"]} filter={filterConfig} />;\n' +
          "}\n",
      },
    ],
    expectedFiles: {
      "src/components/ExpensiveList.tsx":
        '"use client";\n' +
        "\n" +
        'import { memo, useMemo } from "react";\n' +
        "\n" +
        "interface FilterConfig {\n" +
        "  minPrice: number;\n" +
        "  maxPrice: number;\n" +
        "  inStock: boolean;\n" +
        "}\n" +
        "\n" +
        "const ExpensiveList = memo(function ExpensiveList({\n" +
        "  items,\n" +
        "  filter,\n" +
        "}: {\n" +
        "  items: string[];\n" +
        "  filter: FilterConfig;\n" +
        "}) {\n" +
        '  console.log("ExpensiveList rendered");\n' +
        "  return (\n" +
        "    <ul>\n" +
        "      {items.map((item) => (\n" +
        "        <li key={item}>{item}</li>\n" +
        "      ))}\n" +
        "    </ul>\n" +
        "  );\n" +
        "});\n" +
        "\n" +
        "export default function Parent() {\n" +
        "  const filterConfig = useMemo(\n" +
        "    () => ({ minPrice: 0, maxPrice: 100, inStock: true }),\n" +
        "    []\n" +
        "  );\n" +
        "\n" +
        '  return <ExpensiveList items={["a", "b", "c"]} filter={filterConfig} />;\n' +
        "}\n",
    },
    assertions: [
      {
        label: "Uses useMemo for filterConfig",
        check: (files) => {
          const src = files["src/components/ExpensiveList.tsx"] || "";
          return src.includes("useMemo");
        },
      },
    ],
    timeout: 120,
  },
];

// tool-definitions.ts — OpenAI-compatible function-calling schema
// Used by M3 native tool calling (replaces XML parsing)
//
// NOTE: system-prompt text moved to master-prompt.ts (single source of
// truth). This file now only holds the tool schemas.

export const M3_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the full file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in a path. Use '.' for root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: '.')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          content: { type: "string", description: "Full content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file_chunk",
      description: "Append content to an existing file. Use for large files — write in chunks of 200-300 lines each. First call write_file with the initial content, then use write_file_chunk to append subsequent sections.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          content: { type: "string", description: "Content chunk to append (200-300 lines max)" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Find and replace text in a file. Use this for targeted edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          old_text: { type: "string", description: "Exact text to find" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_edit",
      description: "Edit multiple files in one call. Use for coordinated refactors across files — e.g. renaming a function used in 5 files, or adding an import to multiple files.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path" },
                old_text: { type: "string", description: "Text to find" },
                new_text: { type: "string", description: "Replacement text" },
              },
              required: ["path", "old_text", "new_text"],
            },
            description: "Array of file edits to apply",
          },
        },
        required: ["edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search for a pattern in the codebase. Returns matching files and line numbers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term or pattern" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_search",
      description: "Search with context FIRST before reading files: grouped per-file matching-line snippets plus a ready-made read_file offset/limit hint per match — locate regions without reading whole files. Prefer this over search_code when you need to see the surrounding code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term or pattern" },
          context: { type: "number", description: "Context lines around each match (0-10, default 3)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command. Use for running tests, builds, linters, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_in_sandbox",
      description: "Run a command in an isolated sandbox environment. Safer than run_command — use for untrusted code, npm install, builds, tests. Requires E2B_API_KEY in env.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute in sandbox" },
          timeout: { type: "number", description: "Timeout in seconds (default 60)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Use when you need up-to-date facts, documentation, library versions, or real-world data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last_change",
      description: "Undo the last file write (restore previous version).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Capture a screenshot of a URL for verifying websites you build.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to screenshot" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_list",
      description: "Create or update a task plan. Show the user what you plan to do, then update as you complete each step. Use this at the start of complex tasks.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "complete", "clear"], description: "Action to perform" },
          items: { type: "array", items: { type: "string" }, description: "Task items (for create/update)" },
          completed_index: { type: "number", description: "0-based index of item to mark complete (for complete action)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scratchpad_update",
      description: "Write to your private scratchpad (plan, hypotheses, findings, next move). It is re-shown to you every turn and never shown to the user as a deliverable. Update it as you learn — especially the next move before any irreversible write. Never store secrets or credentials here.",
      parameters: {
        type: "object",
        properties: {
          section: { type: "string", enum: ["plan", "hypotheses", "findings", "next"], description: "Which scratchpad section to replace" },
          content: { type: "string", description: "New section content (plain text, concise)" },
        },
        required: ["section", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_question",
      description: "Ask the user a clarifying question with multiple choice options. Use when you need more details to proceed — ask one question at a time.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask" },
          options: { type: "array", items: { type: "string" }, description: "Multiple choice options (2-5 options)" },
          allow_free_text: { type: "boolean", description: "Allow user to type a custom answer" },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description:
        "Use this tool when you do not have enough information to proceed correctly and making a wrong assumption would waste the user's time or produce a wrong result. Ask ONE focused question. Do NOT use this for optional enhancements — only when the task is genuinely ambiguous or a required input is missing.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The single clarifying question, plain language" },
          context: { type: "string", description: "One sentence explaining WHY you need this (shown to the user)" },
          options: { type: "array", items: { type: "string" }, description: "2-4 short option labels, optional but preferred" },
          allow_freetext: { type: "boolean", description: "Whether to also accept a typed reply (default true)" },
        },
        required: ["question", "context"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_browser",
      description: "Fetch a URL and render it in the preview panel. Use to verify web pages, check API responses, or view rendered HTML. Returns the page title, content type, and size.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to preview (http:// or https://)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_app",
      description: "Full browser verification of the app: starts the dev server, loads the page in a headless browser, and captures a screenshot plus all console errors/warnings. Use after building or changing a web app to PROVE it works — this is the preferred final step for any UI task. Returns PASS or the list of console errors found.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path to verify, e.g. \"/\" or \"/about\" (default \"/\")" },
          dev_command: { type: "string", description: "Dev server start command, e.g. \"npm run dev\" (default)" },
          port: { type: "number", description: "Port to start/serve the app on (default 5000)" },
          interactions: {
            type: "array",
            description: "Optional interactions to perform before the screenshot (click buttons, fill forms)",
            items: {
              type: "object",
              properties: {
                action: { type: "string", description: "click | scroll | type | wait" },
                selector: { type: "string", description: "CSS selector for click/type actions" },
                value: { type: "string", description: "Value for type actions or ms for wait" },
              },
            },
          },
        },
      },
    },
  },
  // === AGENT BROWSER — the AI's own real browser (Electron) =============
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate YOUR browser (a real Chromium you control, visible to the user in the preview panel) to a URL. Waits for the page to load. Use it to research docs, test the app you built, log into services, or fetch live information. Returns the final URL and page title (redirects included).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to load, e.g. https://example.com or http://localhost:3001" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Read what is currently shown in YOUR browser: page URL, title, visible text, headings, and interactive elements (links, buttons, inputs with selectors you can use for browser_click/browser_type). Call this after navigating to understand the page. For precise targeting use browser_find instead — it returns click-ready refs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element in YOUR browser by CSS selector, or by ref from browser_find (ref=e3). The element is scrolled into view first. Returns what was clicked; waits for any resulting navigation.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector, e.g. \"#submit-btn\", \"a[href='/pricing']\"" },
          ref: { type: "string", description: "Element ref from browser_find (e.g. \"e3\") — use INSTEAD of selector" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Type text into an input/textarea in YOUR browser (clears existing value first, fires input/change events so frameworks notice). Target by selector or by ref from browser_find.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the input element" },
          ref: { type: "string", description: "Element ref from browser_find (e.g. \"e3\") — use INSTEAD of selector" },
          text: { type: "string", description: "Text to enter" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press",
      description: "Press a key in YOUR browser (e.g. Enter to submit a search/form, Escape to close a dialog). Real OS-level key event.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name, e.g. \"Enter\", \"Escape\", \"Tab\"" },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll YOUR browser's page (positive = down, negative = up), then re-read content with browser_read.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Pixels to scroll (default 600)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_console",
      description: "Get all console messages (errors/warnings/logs) from the current page in YOUR browser since the last navigation. Essential after browser_click or testing your app — JS errors appear here.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Capture what YOUR browser is showing right now. The screenshot is AUTOMATICALLY attached inline in the chat (you and the user both see it) and its contents are described back to you — never claim you cannot attach, embed, or view screenshots. Prefer browser_read for extracting text content. Optionally capture the full scrollable page or a specific viewport size to check responsive layouts.",
      parameters: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "Capture the entire scrollable page, not just the viewport (default false)" },
          viewpoint: { type: "string", description: "Resize to a named viewport before capturing: desktop (1280x720), tablet (768x1024), or mobile (390x844) — use to verify responsive layouts" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_find",
      description: "Find actionable elements on the current page (links, buttons, inputs, selects) with accessibility roles, labels, and STABLE selectors. Returns refs (e1, e2, …) you can pass to browser_click/browser_type/browser_hover/browser_select instead of guessing CSS selectors. Filter by role (link/button/textbox/combobox/heading) and/or text. Re-run after navigation — refs go stale.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Case-insensitive substring to match against element name/label/selector" },
          role: { type: "string", description: "ARIA-ish role filter: link, button, textbox, combobox, heading, …" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait_for",
      description: "Wait for a condition before continuing: text to appear, a selector to become visible, or a fixed delay. Use after clicks that trigger async loads/SPA transitions instead of blind browser_read retries.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to wait for (use this OR selector OR time)" },
          selector: { type: "string", description: "CSS selector to wait until visible (use this OR text OR time)" },
          time: { type: "number", description: "Milliseconds to wait (use this OR text OR selector; capped at 10s)" },
          timeoutMs: { type: "number", description: "Max time to wait for text/selector (default 10000, capped 15s)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_hover",
      description: "Hover over an element in YOUR browser (by selector or browser_find ref) — triggers hover menus, tooltips, and reveal-on-hover UI. Wait ~300ms is built in; browser_read or browser_screenshot afterwards to see what appeared.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          ref: { type: "string", description: "Element ref from browser_find (e.g. \"e3\") — use INSTEAD of selector" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_select",
      description: "Choose an <option> in a <select> dropdown in YOUR browser (by value, or visible label for common cases). Target by selector or browser_find ref.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the <select> element" },
          ref: { type: "string", description: "Element ref from browser_find (e.g. \"e3\") — use INSTEAD of selector" },
          value: { type: "string", description: "Option value (or visible label) to select" },
        },
        required: ["value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_tabs",
      description: "Manage browser tabs: list open tabs, open a new tab (optionally navigating immediately), switch the active tab by index, or close one. Ops run against the ACTIVE tab — switch first, then navigate/click/read.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list (default) | new | switch | close" },
          url: { type: "string", description: "For action=new: URL to open in the new tab (optional)" },
          index: { type: "number", description: "For action=switch/close: tab index from the last list" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_network",
      description: "Show failed network requests from YOUR browser: HTTP 4xx/5xx responses and aborted requests since the session started. Essential when a page loads blank or data is missing — the failing URL and status tell you whether it's your app or its API.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description: "Run JavaScript in YOUR browser's page context and get the result (read-only checks: computed styles, element counts, localStorage, fetch results). The last expression's value is returned — end with an expression, not a statement.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript expression/IIFE, e.g. \"document.querySelectorAll('.card').length\"" },
        },
        required: ["code"],
      },
    },
  },
  // === UNIVERSAL MCP CALLER — available on EVERY provider (full + lean).
  //  Call any connected MCP tool by server id + tool name + arguments.
  //  Use mcp_search_tools to find tools, mcp_describe_tool for exact schemas.
  //  This is the MCP path for lean providers (groq, nvidia, any BYOK) that
  //  don't get per-tool MCP definitions in the function-calling array.
  {
    type: "function",
    function: {
      name: "mcp_call",
      description: "Call a tool on a connected MCP server by name. Use when the server's per-tool definitions are not in your function-calling list (lean providers) — discover tools first with mcp_search_tools and get exact parameters with mcp_describe_tool. serverId is the MCP server id shown in MCP connectors (e.g. \"supabase\", \"linear\"). tool is the tool name on that server (e.g. \"list_tables\", \"create_issue\"). arguments is the tool's parameter object. Results arrive as tool_result. Never invent server ids or tool names — use mcp_search_tools to list what's actually connected.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string", description: "MCP server id (from MCP connectors, e.g. \"supabase\", \"linear\", \"filesystem\") — never invent one" },
          tool: { type: "string", description: "Tool name on that server (e.g. \"list_tables\", \"create_issue\") — discover with mcp_search_tools if unsure" },
          arguments: { type: "object", description: "Tool parameter object (keys/values per the tool's schema). Pass {} or omit if the tool takes no args." },
        },
        required: ["serverId", "tool"],
      },
    },
  },
];

// Updated system prompt — no XML tool instructions needed
// M3 gets tool definitions via the `tools` parameter natively
// (System-prompt text and effort styles live in master-prompt.ts.)

/**
 * Lean tool set for tight-TPM providers (Groq + NVIDIA free tiers, ~8k TPM):
 * the full schema array blows the per-minute budget, but slicing to the
 * first few entries silently amputated whole verbs — models then truthfully
 * claimed they "can't help" with browsing. This curated set keeps every
 * family (inspect, create, execute, plan, lookup, browse) with the cheapest
 * schemas, so constrained models stay fully capable.
 */
export const COMPACT_TOOL_PROVIDERS = ["groq", "nvidia"];

/**
 * Providers known to handle the full schema array (large context / billed
 * tiers). Everything NOT in this list OR in COMPACT_TOOL_PROVIDERS gets the
 * lean set. Lean is now safe for MCP: every provider (including lean groq/
 * nvidia and any BYOK endpoint) still gets the generic mcp_call built-in +
 * the search/describe discovery tools, so MCP is never blind on any provider.
 * Default-compact for truly-unknown endpoints is deliberate (unknown TPM
 * ceiling), but MCP capability is preserved via mcp_call.
 */
export const FULL_TOOL_PROVIDERS = [
  "openrouter",
  "anthropic",
  "openai",
  "gemini",
  "mistral",
  "deepseek",
  "together",
  "xai",
  "fireworks",
  "cerebras",
  "minimax",
];

/** Which schema array a provider config gets. Matches platform keys, key-pool
 *  entries ("<id>-pool"), BYOK personal keys ("<id>-personal"), display
 *  labels ("NVIDIA NIM") — known full-tier ids get the full set.
 * Anything in COMPACT_TOOL_PROVIDERS (groq, nvidia) gets the lean set.
 * Everything else (incl. BYOK providers served via OpenRouter, or unknown
 * endpoints) gets the full set — EXCEPT groq/nvidia, which are explicitly
 * lean because their free-tier TPM cap (~8k/min) 413s the full schema array.
 * Lean providers still get mcp_call + discovery tools, so MCP always works.
 */
export function usesCompactTools(providerName: string): boolean {
  const n = (providerName || "").toLowerCase();
  // Known full-tier providers (incl. OpenRouter — the path for most BYOK).
  if (FULL_TOOL_PROVIDERS.some((p) => n.includes(p))) return false;
  // Explicitly lean: tight-TPM free tiers where the full schema array 413s.
  if (COMPACT_TOOL_PROVIDERS.some((p) => n.includes(p))) return true;
  // Default-full for any other endpoint (incl. unknown/custom BYOK):
  // MCP is fully available (per-tool defs + mcp_call + discovery), and the
  // lean-set safety net (mcp_call) is there if a future endpoint turns out
  // to be TPM-constrained. Only groq/nvidia are forced lean.
  return false;
}
export const GROQ_TOOL_NAMES = [
  "read_file",
  "list_files",
  "write_file",
  "edit_file",
  "run_command",
  "todo_list",
  "ask_question",
  "ask_clarification",
  "scratchpad_update",
  "web_search",
  "search_code",
  "code_search",
  "browser_navigate",
  "browser_read",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_wait_for",
  // Screenshot stays callable on lean lanes too: captures auto-attach inline
  // in chat + feed the vision channel, so "take a screenshot" never dead-ends
  // on Groq/NVIDIA the way browsing used to.
  "browser_screenshot",
  // Universal MCP caller — always available, even on lean/groq/nvidia and
  // any BYOK endpoint, so MCP is never blind on any provider. Takes a
  // connected server id + tool name + arguments and dispatches through the
  // same risk gate + lane as a direct mcp__ call. Use mcp_search_tools /
  // mcp_describe_tool to discover tools and get exact schemas.
  "mcp_call",
] as const;

export const GROQ_TOOL_DEFINITIONS = M3_TOOL_DEFINITIONS.filter((t: any) =>
  (GROQ_TOOL_NAMES as readonly string[]).includes(t?.function?.name)
);
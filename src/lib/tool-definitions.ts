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
      description: "Read what is currently shown in YOUR browser: page URL, title, visible text, headings, and interactive elements (links, buttons, inputs with selectors you can use for browser_click/browser_type). Call this after navigating to understand the page.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element in YOUR browser by CSS selector. The element is scrolled into view first. Use browser_read/browser_elements to find selectors. Returns what was clicked; waits for any resulting navigation.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector, e.g. \"#submit-btn\", \"a[href='/pricing']\"" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Type text into an input/textarea in YOUR browser (clears existing value first, fires input/change events so frameworks notice).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the input element" },
          text: { type: "string", description: "Text to enter" },
        },
        required: ["selector", "text"],
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
      description: "Capture what YOUR browser is showing right now. The user sees it live in the preview panel; you get confirmation plus the live page state. Prefer browser_read for extracting text content.",
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
];

// Updated system prompt — no XML tool instructions needed
// M3 gets tool definitions via the `tools` parameter natively
// (System-prompt text and effort styles live in master-prompt.ts.)
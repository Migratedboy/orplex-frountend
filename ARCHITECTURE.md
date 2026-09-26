# Architecture — Orplex Tech

## Overview

Orplex Tech is an AI coding assistant built with Next.js 16, React 18, and PostgreSQL. It provides streaming chat, live file system access, multi-provider AI routing, and an extensible plugin system.

## High-Level Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (React)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ ChatPage │ │RightPanel│ │ Sidebar  │ │CommandPal │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       │             │            │              │        │
│  ┌────┴─────────────┴────────────┴──────────────┴────┐  │
│  │              Context Providers                    │  │
│  │  FileSystem │ Conversation │ BackgroundChat       │  │
│  └────────────────────┬──────────────────────────────┘  │
│                       │                                  │
│  ┌────────────────────┴──────────────────────────────┐  │
│  │              Custom Hooks                         │  │
│  │  useChatSession │ useFileSystem │ useMessages      │  │
│  └────────────────────┬──────────────────────────────┘  │
└───────────────────────┼─────────────────────────────────┘
                        │ HTTP / SSE
┌───────────────────────┼─────────────────────────────────┐
│                  Next.js API Layer                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ /api/chat│ │/api/agent│ │/api/auth │ │/api/files │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       │             │            │              │        │
│  ┌────┴─────────────┴────────────┴──────────────┴────┐  │
│  │              Background Workers                   │  │
│  │  background-worker │ multi-agent │  │
│  └────────────────────┬──────────────────────────────┘  │
│                       │                                  │
│  ┌────────────────────┴──────────────────────────────┐  │
│  │              AI Providers                         │  │
│  │  OpenAI │ Anthropic │ OpenRouter │ Model Router   │  │
│  └────────────────────┬──────────────────────────────┘  │
│                       │                                  │
│  ┌────────────────────┴──────────────────────────────┐  │
│  │              Data Layer                           │  │
│  │  Prisma │ PostgreSQL │ pgvector │ File History     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Module Map — `src/lib/`

### Core Infrastructure
| File | Purpose |
|---|---|
| `constants.ts` | All magic numbers, timeouts, and limits in one place |
| `types.ts` | Branded types, discriminated unions, type guards |
| `errors.ts` | Error hierarchy (AppError → ValidationError, RateLimitError, etc.) |
| `validators.ts` | Zod schemas + sanitization + prompt injection detection |
| `logger.ts` | Pino logging setup |
| `prisma.ts` | Prisma client singleton |
| `graceful-shutdown.ts` | SIGTERM/SIGINT handler for clean server shutdown |
| `error-tracking.ts` | Bugsink/Sentry integration for error reporting |

### AI & Agent
| File | Purpose |
|---|---|
| `ai-providers.ts` | Multi-provider routing (OpenAI, Anthropic, OpenRouter) |
| `model-router.ts` | Smart model selection based on task type |
| `background-worker.ts` | Main tool-calling loop (runs in background) |
| `background-chat.ts` | Global singleton chat store (survives page navigation; snapshots in-flight tasks to sessionStorage for reload recovery) |
| `run-sync.ts` | Mirrors live agent tasks into durable AgentRun rows (browser) |
| `enhanced-system-prompt.ts` | System prompt for the coding agent |
| `tool-definitions.ts` | OpenAI function calling tool schemas |
| `multi-agent.ts` | Multi-agent orchestration with swarm intelligence |
| `langchain-orchestrator.ts` | LangChain plan-and-execute orchestration |
| `reflection-loop.ts` | Self-correcting code generation loop |
| `sparc.ts` | SPARC methodology implementation |
| `tree-of-thoughts.ts` | Tree-of-thoughts reasoning |
| `swarm.ts` | Swarm intelligence for multi-agent coordination |
| `blueprint-pattern.ts` | Blueprint pattern for reusable code templates |
| `sona.ts` | Self-Organizing Neural Architecture (learns from trajectories) |
| `context-builder.ts` | Builds context window for LLM calls |
| `rag-retriever.ts` | Retrieval-Augmented Generation for code patterns |
| `vector-memory.ts` | Vector-based semantic memory for the agent |
| `pgvector-search.ts` | pgvector cosine similarity search helpers |
| `semantic-cache.ts` | Cache similar queries to avoid redundant API calls |
| `cost-estimator.ts` | Estimates API call costs before execution |
| `vision-preprocessor.ts` | Image preprocessing for vision models |
| `code-generators.ts` | Code generation utilities |
| `code-quality-checker.ts` | Static analysis and quality scoring |
| `rate-limiter.ts` | Rate limiting with sliding window counters |
| `circuit-breaker.ts` | Circuit breaker for provider resilience |
| `circuit-breaker-reset.ts` | DB-backed auto-reset with advisory locks |
| `key-pool.ts` | API key pool with round-robin and quota tracking |
| `key-encryption.ts` | Encrypt/decrypt API keys at rest |
| `risk-classifier.ts` | Risk-tiered approval for tool calls |

### File System
| File | Purpose |
|---|---|
| `virtual-fs.ts` | In-memory virtual file system for agent operations |
| `file-history.ts` | Track file changes for undo/rollback |
| `file-adapter.ts` | Adapter between virtual FS and real FS |
| `file-download.ts` | Export conversations as markdown |
| `file-utils.ts` | File size formatting, icon selection |
| `diff-hunks.ts` | Parse unified diffs into accept/reject hunks |

### Plugin System
| File | Purpose |
|---|---|
| `plugins/types.ts` | Plugin interface definitions |
| `plugins/registry.ts` | Plugin registration and lifecycle hooks |
| `plugins/initializer.ts` | Plugin discovery and initialization |
| `plugins/server-middleware.ts` | Server-side plugin middleware |
| `plugins/builtin/` | Built-in plugin implementations |

### Eval & Testing
| File | Purpose |
|---|---|
| `eval/types.ts` | Eval task type definitions |
| `eval/runner.ts` | Runs eval tasks against the agent |
| `eval/scorer.ts` | Scores agent output against expected results |
| `eval/cli.ts` | CLI interface for running evals |
| `eval/tasks/` | 41 eval tasks across 10 categories |

### Database & Persistence
| File | Purpose |
|---|---|
| `prisma.ts` | Prisma client (singleton) |
| `approval-store.ts` | In-memory store for pending tool approvals |
| `rate-limit-store.ts` | Rate limit state persistence |
| `backup.ts` | Automated pg_dump backups with rotation |
| `cron-reset.ts` | Daily quota reset with advisory lock |

### Auth & Security
| File | Purpose |
|---|---|
| `auth.ts` | NextAuth configuration |
| `admin-auth.ts` | Admin role checks |
| `chat-middleware.ts` | Chat input middleware (validation, sanitization) |
| `middleware.ts` | HTTP middleware (CORS, CSP, CSRF, request ID) |

## Data Flow

### Chat Message Flow
```
User types message
  → ChatInput.onSend()
    → useChatSession.sendMessage()
      → POST /api/chat (SSE stream)
        → background-worker.ts loop
          → LLM API call (streaming)
            → Tool calls parsed from stream
              → Tool handlers execute (read_file, write_file, etc.)
                → Results sent back to LLM
                  → LLM responds with content
                    → Display updated via background-chat.ts notify()
                      → useChatSession receives update
                        → MessageList re-renders
```

### File Write Flow
```
Agent calls write_file
  → background-worker.ts handler
    → requestApproval() (if medium/high risk)
      → User approves via ApprovalDialog
        → virtualFS.write() (in-memory)
          → writeFile() (File System Access API)
            → recordChange() (file-history.ts)
              → computeDiff() (for Changes tab)
```

## Key Patterns

### Singleton Background Store
The `background-chat.ts` module is a global singleton that survives page navigation. The tool-calling loop runs independently of any React component. When the user returns to the chat page, `useChatSession` subscribes via `subscribeBackgroundChat()` and receives the current state.

### Provider Pattern
React Context providers are nested in `layout.tsx`:
```
Providers (Auth, Toast, Theme)
  └→ BootGate (loading screen)
    └→ FileSystemProvider (file handles, virtual FS)
      └→ HunkDecisionProvider (diff rollback)
        └→ ConversationProvider (active conversation)
          └→ AppLayout (sidebar + content)
```

### Risk-Tiered Approval
Every tool call is classified by `risk-classifier.ts`:
- **Low risk** (read_file, list_files, todo_list): Auto-approved
- **Medium risk** (write_file, edit_file): Standard approval dialog
- **High risk** (rm, sudo): Elevated warning with forced review

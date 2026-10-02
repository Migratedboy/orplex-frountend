---
sidebar_position: 1
---

# Architecture

Orplex Code is a Next.js application with a modular architecture.

## High-Level Overview

```
┌─────────────────────────────────────────────────┐
│                    Frontend                      │
│  React + Next.js + Tailwind CSS                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │  Chat    │ │  Files   │ │ Terminal │        │
│  │  Panel   │ │  Panel   │ │  Panel   │        │
│  └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────┬───────────────────────────┘
                      │ API Routes
┌─────────────────────┴───────────────────────────┐
│                    Backend                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │  Chat    │ │  Agent   │ │  Auth    │        │
│  │  API     │ │  Worker  │ │  API     │        │
│  └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────┐
│              Infrastructure                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │PostgreSQL│ │  Redis   │ │  Prisma  │        │
│  │  (data)  │ │ (cache)  │ │  (ORM)   │        │
│  └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────────────────────────────────┘
```

## Key Modules

| Module | Purpose |
|--------|---------|
| `background-worker.ts` | Tool-calling loop, file operations, command execution |
| `stream-reader.ts` | SSE parsing, tool call extraction, word deduplication |
| `agent-events.ts` | Status emission, preview events |
| `sandbox-exec.ts` | Sandboxed command execution (server-side API) |
| `circuit-breaker.ts` | Provider resilience with DB persistence |
| `sona.ts` | Self-organizing neural architecture |
| `eval/` | 41-task evaluation harness |

## Data Flow

1. User sends message via chat UI
2. `/api/chat` route processes request
3. Model router selects optimal provider
4. SSE stream returns to client
5. Background worker parses tool calls
6. Tools execute (file ops, commands, search)
7. Results fed back to model
8. Loop continues until done

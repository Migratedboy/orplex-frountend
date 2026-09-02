# Orplex Tech — VS Code Extension

AI coding assistant with streaming chat, multi-provider support, and agentic tool calling.

## Features

- **Chat Panel** — Ask questions, get code explanations, fix bugs
- **Fix Code** — Select code → Right-click → "Orplex: Fix Selected Code"
- **Explain Code** — Select code → Right-click → "Orplex: Explain Selected Code"
- **Refactor Code** — Select code → Right-click → "Orplex: Refactor Selected Code"
- **Streaming Responses** — Watch the agent think in real-time
- **Multi-Model** — Use MiniMax M3, Claude, GPT-OSS, or any OpenAI-compatible model

## Setup

1. Install the extension from VS Code Marketplace
2. Set your API URL in settings (`orplex.apiUrl`)
3. Optionally set an API key (`orplex.apiKey`)
4. Open the Orplex panel in the activity bar

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `Orplex: Open Chat` | `Ctrl+Shift+O` | Open the chat panel |
| `Orplex: Fix Selected Code` | — | Fix bugs in selected code |
| `Orplex: Explain Selected Code` | — | Explain what selected code does |
| `Orplex: Refactor Selected Code` | — | Improve selected code |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `orplex.apiUrl` | `http://localhost:5000` | Orplex server URL |
| `orplex.apiKey` | `""` | API key (optional) |
| `orplex.model` | `minimax-m3` | Model to use |
| `orplex.mode` | `code` | Agent mode (ask/plan/code) |

## Requirements

- VS Code 1.90+
- Orplex Tech server running (local or remote)

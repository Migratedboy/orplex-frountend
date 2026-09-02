---
sidebar_position: 3
---

# Configuration

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Yes | Secret for session encryption |
| `NEXTAUTH_URL` | Yes | Your app URL (e.g., `http://localhost:5000`) |
| `OPENROUTER_API_KEY` | No | OpenRouter API key for multi-provider access |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `ANTHROPIC_API_KEY` | No | Anthropic API key |

## AI Provider Configuration

Orplex supports multiple AI providers through OpenRouter or direct API keys.

### Using OpenRouter (Recommended)

```env
OPENROUTER_API_KEY=your-key-here
```

This gives you access to MiniMax M3, Claude, GPT-OSS, and 100+ other models.

### Using Direct API Keys

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Model Selection

The default model is **MiniMax M3** — a 1M context window model with native tool calling.

You can change the model in the UI settings or via the `orplex.model` configuration.

## Security Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_ORIGINS` | `http://localhost:5000` | Comma-separated allowed origins |
| `BLOCKED_COMMANDS` | (built-in) | Additional blocked commands |

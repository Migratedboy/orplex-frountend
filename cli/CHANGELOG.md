# Changelog

All notable changes to the Orplex CLI will be documented in this file.

## [0.1.0] - 2026-09-02

### Added
- **`orplex chat`** — Chat with Orplex AI from your terminal with streaming responses
- **Pipe/stdin mode** — `echo "fix this" | orplex chat` reads from stdin
- **`orplex status`** — Check server health, uptime, memory, and database status
- **`orplex doctor`** — Run health checks on your Orplex setup (Node version, server, DB, API key)
- **`orplex config`** — View or set API URL, API key, and default mode (persisted to `~/.orplex/config.json`)
- **`orplex conversations`** — List recent conversations from the server
- **Config-driven defaults** — All commands read from `~/.orplex/config.json` so you don't repeat flags
- **Agent modes** — `--mode ask|plan|code` for different task types
- **Colored output** — Spinner during thinking, colored responses and error messages

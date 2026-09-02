---
sidebar_position: 1
---

# Installation

## Quick Start (Recommended)

```bash
# Clone and install
git clone https://github.com/orplex-tech/orplex-tech.git
cd orplex-tech
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Start the dev server
npm run dev
```

Open [http://localhost:5000](http://localhost:5000) in your browser.

## Docker / Podman

```bash
# Using Podman (recommended) or Docker
podman-compose up -d
```

This starts Orplex with PostgreSQL and all required services.

## VS Code Extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=orplex-tech.orplex-tech):

```
ext install orplex-tech.orplex-tech
```

## CLI

```bash
npm install -g orplex-cli
orplex chat "fix this bug"
```

## System Requirements

- Node.js 18+
- PostgreSQL 14+ (or use Docker)
- 2GB RAM minimum

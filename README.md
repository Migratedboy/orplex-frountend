# Orplex

AI coding assistant with streaming chat, conversation history, file context, OAuth authentication, and multi-provider inference.

## Current Features

- **AI Chat** - Streaming responses with markdown and code syntax highlighting
- **Conversation History** - Persisted in Supabase PostgreSQL, searchable and renameable
- **File Attachments** - Upload text files and images, sent as context to the AI model
- **OAuth Authentication** - Google and GitHub sign-in via NextAuth.js
- **Multi-Provider AI** - OpenRouter (primary) with NVIDIA fallback
- **Bug Report** - In-app bug reporting with email notification
- **Dark Mode** - Toggle between light and dark themes
- **Keyboard Shortcuts** - Ctrl+K search, Ctrl+N new chat, Esc stop generation
- **Mobile Responsive** - Hamburger menu, responsive layout

## In Development

- Real agent loop with tool execution (read/write/edit files, run commands)
- Repository indexing and code search
- Test runner integration
- Git integration and PR creation
- Code diff viewer with accept/reject
- Task persistence and history

## Getting Started

### Prerequisites

- Node.js v18+
- A Supabase project (for PostgreSQL database)
- OpenRouter API key (free tier available)
- Google OAuth credentials (optional)

### Installation

```bash
git clone https://github.com/Migratedboy/orplex-agentic-codiing-.git
cd orplex-agentic-codiing-
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
# Database (Supabase)
DATABASE_URL=postgresql://postgres:your-password@your-project.supabase.co:5432/postgres

# Auth
NEXTAUTH_URL=http://localhost:5000
NEXTAUTH_SECRET=your-random-secret-here

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# AI Providers
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct
NVIDIA_API_KEY=your-nvidia-key
NVIDIA_MODEL=meta/llama-3.1-70b-instruct

# CORS
ALLOWED_ORIGINS=http://localhost:5000
```

### Run

```bash
npm run dev
```

Open http://localhost:5000

### Database Setup

```bash
# Push schema to Supabase
npx prisma db push

# Generate Prisma client
npx prisma generate
```

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript
- **Styling**: CSS Modules (Obsidian Amber theme)
- **Database**: Supabase (PostgreSQL) via Prisma
- **Auth**: NextAuth.js with Google/GitHub OAuth
- **AI**: OpenRouter + NVIDIA API with streaming SSE
- **Validation**: Zod schemas on all API inputs

## Architecture

```
User Request
    |
    v
Next.js API Route (/api/chat)
    |
    v
Provider Fallback Chain
    |-- OpenRouter (primary)
    |-- NVIDIA (fallback)
    |
    v
SSE Stream to Client
    |
    v
React UI (streaming render)
```

## Security

- All API routes require authentication (except health check)
- CSRF protection via Content-Type validation
- Dynamic CORS origin matching
- Zod input validation on all endpoints
- Rate limiting (30 req/min per user+IP)
- SQL injection prevention via Prisma ORM
- XSS prevention via React auto-escaping
- CSP headers configured

## License

MIT

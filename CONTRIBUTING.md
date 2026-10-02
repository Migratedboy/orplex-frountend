# Contributing to Orplex Code

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents

- [Quick Start](#quick-start)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Conventions](#coding-conventions)
- [PR Guidelines](#pr-guidelines)
- [Contributing to Satellite Projects](#contributing-to-satellite-projects)
- [Release Process](#release-process)
- [Code of Conduct](#code-of-conduct)

---

## Quick Start

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/orplex-tech.git
cd orplex-tech

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and NEXTAUTH_SECRET

# 4. Start the database
podman-compose up -d db

# 5. Run database migrations
npx prisma generate
npx prisma db push

# 6. Start the dev server
npm run dev
```

Open [http://localhost:5000](http://localhost:5000) and you're running.

---

## Development Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20.x | Runtime (exact version in `.nvmrc`) |
| PostgreSQL | 16+ | Database (or use Docker/Podman) |
| Podman or Docker | Latest | Container runtime |
| Git | 2.30+ | Version control |

### Recommended VS Code Extensions

| Extension | Why |
|-----------|-----|
| ESLint | Linting inline |
| Prettier | Code formatting |
| Prisma | Schema highlighting |
| Tailwind CSS IntelliSense | Class autocomplete |
| Error Lens | Inline error display |

### Environment Variables

See `.env.example` for the full list. Key variables:

```env
# Required
DATABASE_URL=postgresql://localhost:5432/orplex
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:5000

# AI Providers (at least one needed)
OPENROUTER_API_KEY=sk-or-...
# or
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
NVIDIA_API_KEY=nvapi-...
```

### Database

```bash
# Start PostgreSQL
podman-compose up -d db

# Generate Prisma client
npx prisma generate

# Push schema to database (dev only — no migrations)
npx prisma db push

# Reset database (WARNING: destroys data)
npx prisma db push --force-reset

# Open Prisma Studio (visual DB browser)
npx prisma studio
```

### Useful Commands

```bash
npm run dev          # Start dev server on port 5000
npm run build        # Production build
npm run lint         # ESLint
npm run typecheck    # TypeScript type checking (no emit)
npm test             # Run all tests
npm test -- --watch  # Run tests in watch mode
```

---

## Project Structure

```
orplex-tech/
├── src/
│   ├── app/                  # Next.js App Router pages + API routes
│   │   ├── api/              # 32 API routes (chat, agent, auth, etc.)
│   │   ├── admin/            # Admin dashboard
│   │   ├── history/          # Conversation history
│   │   ├── plugins/          # Plugin browser
│   │   ├── runs/             # Agent run management
│   │   └── settings/         # User settings
│   ├── components/           # 48 React components
│   └── lib/                  # 59 TypeScript modules
│       ├── __tests__/        # Unit tests (15 files, 263 tests)
│       ├── agent/            # Agent runtime
│       ├── eval/             # Evaluation harness (41 tasks)
│       ├── free-tier/        # Free tier quota management
│       ├── plugins/          # Plugin system
│       └── workspace/        # Multi-user workspace management
├── prisma/                   # Database schema
├── vscode-extension/         # VS Code extension (separate project)
├── cli/                      # CLI tool (separate project)
├── docs-site/                # Docusaurus documentation site
└── .github/                  # CI/CD workflows, issue templates
```

For a detailed module-by-module breakdown, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Development Workflow

### Branch Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature/` | New features | `feature/add-billing` |
| `fix/` | Bug fixes | `fix/quota-reset-race` |
| `refactor/` | Code restructuring | `refactor/split-worker` |
| `docs/` | Documentation | `docs/add-api-reference` |
| `chore/` | Maintenance | `chore/update-deps` |
| `test/` | Tests | `test/add-workspace-tests` |

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add virtual scrolling for message list
fix: prevent crash when LLM returns object in todo_list items
refactor: extract tool handlers from background-worker.ts
docs: update architecture diagram with new modules
test: add quota-manager unit tests
chore: update eslint to v9
security: add prompt injection detection to validators
```

The release-drafter uses these prefixes to auto-categorize changes in release notes.

### Workflow

1. Create a branch from `main` (or `develop` if it exists)
2. Make your changes
3. Run checks before committing:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```
4. Commit with a conventional commit message
5. Push and open a PR against `main`
6. Address review feedback
7. Merge after CI passes and review approval

---

## Coding Conventions

### TypeScript

```typescript
// ✅ Use interface for object shapes
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ✅ Use type for unions and utility types
type AgentMode = "ask" | "plan" | "code";

// ✅ Prefer unknown over any — validate at boundaries
function parseInput(raw: unknown): ChatMessage {
  return chatMessageSchema.parse(raw);
}

// ❌ Don't use any
function process(data: any) { ... } // BAD

// ✅ Use branded types for IDs (see src/lib/types.ts)
type UserId = string & { __brand: "UserId" };

// ✅ Handle errors explicitly
try {
  await riskyOperation();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "Operation failed");
}
```

### React

```typescript
// ✅ Client components get "use client" at the top
"use client";

// ✅ Components go in src/components/
// ✅ Keep components focused — one concern per file

// ✅ Use useCallback for functions passed as props
const handleSend = useCallback((text: string) => {
  sendMessage(text);
}, [sendMessage]);

// ✅ Prefer controlled forms with state
const [value, setValue] = useState("");

// ❌ Don't mutate state directly
items.push(newItem); // BAD
setItems([...items, newItem]); // GOOD
```

### API Routes

```typescript
// ✅ Validate input with Zod (see src/lib/validators.ts)
const parsed = chatMessageSchema.safeParse(body);
if (!parsed.success) {
  return Response.json(
    { error: parsed.error.issues[0].message },
    { status: 400 },
  );
}

// ✅ Use consistent error format
return Response.json(
  { success: false, error: { message: "..." } },
  { status: 400 },
);

// ✅ Check auth first in every route
const session = await getServerSession(authOptions);
if (!session?.user?.id) {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
```

### LLM Output

**Never trust LLM output directly.** Always validate at boundaries:

```typescript
// ✅ Safe coercion
const text = typeof result === "string" ? result : JSON.stringify(result);

// ✅ Validate tool call arguments
const args = toolCallSchema.parse(rawArgs);

// ✅ Check for expected types
if (parsed.content && typeof parsed.content === "string") {
  streamed += parsed.content;
}
```

### Testing

```typescript
// ✅ Test file naming: thingUnderTest.test.ts
// ✅ Place tests in src/lib/__tests__/

describe("rate-limiter", () => {
  describe("checkUserQuota", () => {
    it("allows requests within daily limit", () => {
      const result = checkUserQuota("user-1", {
        requestsToday: 10,
        dailyLimit: 50,
        lastResetAt: new Date(),
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(40);
    });
  });
});

// Run tests
npm test                    # All tests
npm test -- --watch         # Watch mode
npm test -- --coverage      # With coverage report
npm test -- quota-manager   # Run specific test file
```

### File Organization

| Where | What |
|-------|------|
| `src/app/api/*/route.ts` | API route handlers |
| `src/app/*/page.tsx` | Page components |
| `src/components/*.tsx` | Reusable UI components |
| `src/lib/*.ts` | Business logic, utilities, services |
| `src/lib/__tests__/*.test.ts` | Unit tests |
| `prisma/schema.prisma` | Database schema |

---

## PR Guidelines

### Before Opening a PR

- [ ] Code compiles without errors (`npm run typecheck`)
- [ ] No lint errors (`npm run lint`)
- [ ] All tests pass (`npm test`)
- [ ] New code has tests (when applicable)
- [ ] Commit messages follow conventional commits

### PR Description Template

Use this structure in your PR description:

```markdown
## What

Brief description of the change.

## Why

Motivation and context. Link to issue if applicable.

## How

Technical approach and key decisions.

## Testing

How this was tested.

## Screenshots

UI changes only — before/after screenshots.
```

### PR Rules

1. **One PR = one concern.** Don't mix unrelated changes.
2. **Keep PRs small.** Aim for < 500 lines changed. Split large changes into stacked PRs.
3. **Write descriptive titles.** Use conventional commit format: `feat: add workspace invite flow`
4. **Link issues.** Reference `Closes #123` in the PR body.
5. **Request reviewers.** The CODEOWNERS file auto-assigns relevant teams.
6. **Respond to feedback.** Push new commits (don't force-push during review).
7. **Squash merge.** We squash-merge into `main` to keep history clean.

### Review Checklist (for reviewers)

- [ ] Code follows project conventions
- [ ] No security issues (auth checks, input validation, no secrets in code)
- [ ] Error handling is appropriate
- [ ] No unnecessary console.logs or debug code
- [ ] Tests cover the new behavior
- [ ] Documentation updated (if applicable)

---

## Contributing to Satellite Projects

### VS Code Extension (`vscode-extension/`)

```bash
cd vscode-extension
npm install
npm run compile      # Build
npm run watch        # Watch mode for development

# Test in VS Code
# 1. Open the vscode-extension folder in VS Code
# 2. Press F5 to launch Extension Development Host
# 3. Test your changes in the new window
```

**Key files:**
- `src/extension.ts` — Entry point, registers commands
- `src/sidebar/ChatViewProvider.ts` — Chat webview panel
- `src/commands/codeActions.ts` — Fix/Explain/Refactor
- `src/providers/` — CodeLens, diagnostics, inline chat, model picker

### CLI Tool (`cli/`)

```bash
cd cli
npm install
npm run build        # Build TypeScript
npm run dev          # Run with tsx (no build needed)

# Test locally
node bin/orplex chat "hello"
node bin/orplex status
node bin/orplex doctor
```

**Key files:**
- `src/index.ts` — Command definitions
- `src/commands/chat.ts` — Chat with streaming
- `src/commands/config.ts` — Config management
- `src/commands/doctor.ts` — Health checks

### Docs Site (`docs-site/`)

```bash
cd docs-site
npm install
npm run start        # Dev server with hot reload
npm run build        # Production build
npm run serve        # Serve production build locally
```

**Key files:**
- `docs/**/*.md` — Markdown content (MDX)
- `docusaurus.config.js` — Site configuration
- `sidebars.js` — Navigation structure
- `src/pages/index.js` — Homepage
- `src/css/custom.css` — Theme overrides

---

## Release Process

### For maintainers

1. **Draft release notes** — Release-drafter auto-accumulates PRs into a draft
2. **Bump version** — Update version in the relevant `package.json`
3. **Tag and push:**
   ```bash
   # Main app release
   git tag v1.0.0
   git push origin v1.0.0

   # VS Code extension release
   git tag vscode-v0.1.0
   git push origin vscode-v0.1.0

   # CLI release
   git tag cli-v0.1.0
   git push origin cli-v0.1.0
   ```
4. **CI handles the rest** — publish workflows build, test, and publish

---

## Code of Conduct

- Be respectful in issues, PRs, and discussions
- Focus on the code, not the person
- Ask questions if something is unclear
- Celebrate contributions of all sizes
- Welcome newcomers warmly

## Questions?

- **Bugs:** Open a [bug report](https://github.com/orplex-tech/orplex-tech/issues/new?template=bug_report.yml)
- **Features:** Open a [feature request](https://github.com/orplex-tech/orplex-tech/issues/new?template=feature_request.yml)
- **Security:** See [SECURITY.md](./SECURITY.md) — do NOT open a public issue
- **Chat:** Join [Discord](https://discord.gg/orplex)

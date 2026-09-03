/**
 * skills.ts — Worldwide AI coding skills (100+ skills)
 *
 * Sourced from: Claude Code marketplace, Cursor community,
 * awesome-agent-skills, Vercel, Trail of Bits, Remotion, and more.
 *
 * Each skill is a pre-built prompt template that gets injected
 * into the user's message when selected from the + menu.
 */

export interface Skill {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  promptPrefix: string;
}

export interface SkillCategory {
  id: string;
  name: string;
  icon: string;
  skills: Skill[];
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  // ================================================================
  // 🧠 REASONING & PLANNING
  // ================================================================
  {
    id: "reasoning",
    name: "Reasoning & Planning",
    icon: "🧠",
    skills: [
      {
        id: "chain-of-thought",
        name: "Chain of Thought",
        icon: "🔗",
        category: "reasoning",
        description: "Step-by-step logical reasoning",
        promptPrefix:
          "[SKILL: chain-of-thought] Think through this step-by-step. Break down the problem, analyze each component, and reason through the solution methodically before providing your answer.",
      },
      {
        id: "tree-of-thought",
        name: "Tree of Thought",
        icon: "🌳",
        category: "reasoning",
        description: "Explore multiple solution paths",
        promptPrefix:
          "[SKILL: tree-of-thought] Explore at least 3 different approaches to solve this problem. For each approach, list pros and cons, then recommend the best one with justification.",
      },
      {
        id: "self-reflection",
        name: "Self-Reflection",
        icon: "🪞",
        category: "reasoning",
        description: "Review and critique your own output",
        promptPrefix:
          "[SKILL: self-reflection] After generating your response, review it critically. Identify any errors, edge cases, or improvements. Revise your answer based on this self-critique before presenting the final result.",
      },
      {
        id: "first-principles",
        name: "First Principles",
        icon: "🎯",
        category: "reasoning",
        description: "Break problem down to fundamentals",
        promptPrefix:
          "[SKILL: first-principles] Decompose this problem to its fundamental truths. Strip away assumptions and conventions. Rebuild the solution from the ground up based on core principles.",
      },
      {
        id: "karpathy-rules",
        name: "Karpathy's LLM Rules",
        icon: "🎓",
        category: "reasoning",
        description: "Andrej Karpathy's 4 rules for LLM coding",
        promptPrefix:
          "[SKILL: karpathy-rules] Follow Karpathy's four rules: (1) Think before coding — understand the problem fully before writing anything. (2) Simplicity first — start with the simplest solution that works. (3) Surgical changes — make minimal, focused edits rather than rewriting everything. (4) Goal-driven execution — always know what 'done' looks like before starting. Apply these principles to the current task.",
      },
      {
        id: "grill-me",
        name: "Grill Me (Plan Interview)",
        icon: "🔥",
        category: "reasoning",
        description: "Interview about the plan before coding",
        promptPrefix:
          "[SKILL: grill-me] Before writing any code, interview me relentlessly about this plan. Ask clarifying questions about: requirements, constraints, edge cases, expected behavior, technical choices, and potential risks. Don't proceed until we have shared understanding. Be direct and thorough.",
      },
      {
        id: "superpowers-planning",
        name: "Superpowers (TDD + Plans)",
        icon: "💪",
        category: "reasoning",
        description: "Structured multi-step dev with TDD",
        promptPrefix:
          "[SKILL: superpowers] Structure this as a multi-step development task: (1) Create a detailed implementation plan with subtasks. (2) For each subtask, write tests FIRST (TDD). (3) Implement the minimum code to pass tests. (4) Refactor while keeping tests green. (5) Review the full implementation. Use subagents for parallel work where possible.",
      },
      {
        id: "handoff",
        name: "Session Handoff",
        icon: "🤝",
        category: "reasoning",
        description: "Compress session into handoff doc",
        promptPrefix:
          "[SKILL: handoff] Compress the current work into a structured handoff document. Include: (1) Purpose of the next session, (2) Key context and decisions made, (3) Current state of the codebase, (4) Known issues or TODOs, (5) Suggested next steps, (6) Relevant file paths and their roles. Format as markdown that another agent can pick up.",
      },
    ],
  },

  // ================================================================
  // 🔍 ANALYSIS & REVIEW
  // ================================================================
  {
    id: "analysis",
    name: "Analysis & Review",
    icon: "🔍",
    skills: [
      {
        id: "code-review",
        name: "Code Review",
        icon: "📋",
        category: "analysis",
        description: "Deep review for bugs, security, quality",
        promptPrefix:
          "[SKILL: code-review] Perform a thorough code review. Check for: (1) runtime errors and null references, (2) security vulnerabilities (XSS, injection, secrets), (3) performance issues (N+1 queries, memory leaks), (4) code quality (naming, duplication, complexity), (5) missing edge cases. Rate severity of each finding.",
      },
      {
        id: "security-audit",
        name: "Security Audit",
        icon: "🛡️",
        category: "analysis",
        description: "Find vulnerabilities and attack vectors",
        promptPrefix:
          "[SKILL: security-audit] Perform a security audit. Check for: OWASP Top 10 vulnerabilities, exposed secrets/keys, SQL injection, XSS, CSRF, path traversal, insecure deserialization, broken authentication, sensitive data exposure. For each finding, provide severity (Critical/High/Medium/Low) and remediation steps.",
      },
      {
        id: "trail-of-bits-security",
        name: "Trail of Bits Security",
        icon: "🔬",
        category: "analysis",
        description: "CodeQL + Semgrep vulnerability analysis",
        promptPrefix:
          "[SKILL: trail-of-bits-security] Run a Trail of Bits-style security analysis. Use static analysis patterns from CodeQL and Semgrep. Check for: (1) memory safety issues, (2) cryptographic misuse, (3) race conditions, (4) privilege escalation, (5) supply chain risks, (6) deserialization attacks, (7) SSRF/CSRF. Map findings to CWE IDs. Provide proof-of-concept where possible.",
      },
      {
        id: "performance-profile",
        name: "Performance Profile",
        icon: "⚡",
        category: "analysis",
        description: "Find bottlenecks and optimize",
        promptPrefix:
          "[SKILL: performance-profile] Profile this code for performance issues. Identify: (1) time complexity bottlenecks, (2) unnecessary allocations, (3) blocking I/O, (4) missing caching opportunities, (5) N+1 queries, (6) large bundle sizes. Provide specific optimization recommendations with estimated impact.",
      },
      {
        id: "dependency-audit",
        name: "Dependency Audit",
        icon: "📦",
        category: "analysis",
        description: "Check dependencies for issues",
        promptPrefix:
          "[SKILL: dependency-audit] Audit the project dependencies. Check for: outdated packages, known CVEs, unused dependencies, duplicate packages, bundle size impact, license compatibility. Recommend specific version upgrades where needed.",
      },
      {
        id: "complexity-estimate",
        name: "Complexity Estimate",
        icon: "📊",
        category: "analysis",
        description: "Estimate code complexity",
        promptPrefix:
          "[SKILL: complexity-estimate] Analyze the code complexity. Calculate cyclomatic complexity, cognitive complexity, and maintainability index for each function. Flag any function with complexity > 10. Suggest refactoring targets.",
      },
      {
        id: "merge-conflict-resolver",
        name: "Merge Conflict Resolver",
        icon: "⚔️",
        category: "analysis",
        description: "Resolve git merge conflicts",
        promptPrefix:
          "[SKILL: merge-conflict-resolve] Resolve merge conflicts systematically. For each conflict: (1) Understand both sides' intent, (2) Check if changes are compatible, (3) Merge imports/configs carefully, (4) Preserve tests from both branches, (5) Regenerate lock files if needed, (6) Handle deleted-but-modified files with backup. Never silently discard either side.",
      },
    ],
  },

  // ================================================================
  // ✍️ CODE GENERATION
  // ================================================================
  {
    id: "generation",
    name: "Code Generation",
    icon: "✍️",
    skills: [
      {
        id: "test-generator",
        name: "Test Generator",
        icon: "🧪",
        category: "generation",
        description: "Generate comprehensive test suites",
        promptPrefix:
          "[SKILL: test-generator] Generate comprehensive tests. Include: (1) unit tests for each public function, (2) edge case tests (null, empty, boundary values), (3) error handling tests, (4) integration tests. Use the project's existing test framework. Aim for >90% branch coverage.",
      },
      {
        id: "doc-generator",
        name: "Doc Generator",
        icon: "📖",
        category: "generation",
        description: "Generate documentation and README",
        promptPrefix:
          "[SKILL: doc-generator] Generate comprehensive documentation. Include: (1) API docs with JSDoc/TSDoc, (2) usage examples, (3) parameter descriptions, (4) return type docs, (5) error scenarios. Follow the project's existing documentation style.",
      },
      {
        id: "api-scaffold",
        name: "API Scaffold",
        icon: "🏗️",
        category: "generation",
        description: "Scaffold REST/GraphQL API endpoints",
        promptPrefix:
          "[SKILL: api-scaffold] Scaffold a complete API endpoint. Include: (1) route handler with HTTP methods, (2) Zod/Joi validation, (3) error handling with status codes, (4) auth middleware, (5) TypeScript types, (6) DB queries via ORM. Follow existing API patterns.",
      },
      {
        id: "graphql-scaffold",
        name: "GraphQL Scaffold",
        icon: "◈",
        category: "generation",
        description: "Generate GraphQL schema, resolvers, and queries",
        promptPrefix:
          "[SKILL: graphql-scaffold] Scaffold a complete GraphQL implementation. Include: (1) SDL schema with types, queries, mutations, subscriptions, (2) Resolvers with DataLoader for N+1 prevention, (3) Input validation with directives, (4) Error handling union types, (5) Code generation config, (6) Client-side queries/mutations. Use the project's GraphQL stack.",
      },
      {
        id: "docker-setup",
        name: "Docker / CI Setup",
        icon: "🐳",
        category: "generation",
        description: "Create Dockerfile and CI pipeline",
        promptPrefix:
          "[SKILL: docker-setup] Create Docker and CI configuration. Include: (1) multi-stage Dockerfile with optimized layers, (2) docker-compose.yml for local dev, (3) .dockerignore, (4) GitHub Actions CI workflow with lint, test, build, (5) environment variable handling.",
      },
      {
        id: "migration-script",
        name: "Migration Script",
        icon: "🗃️",
        category: "generation",
        description: "Generate database migration scripts",
        promptPrefix:
          "[SKILL: migration-script] Generate a database migration. Include: (1) up migration with indexes, (2) down migration for rollback, (3) data migration if needed, (4) foreign key constraints, (5) index optimization. Use the project's existing ORM/migration tool.",
      },
      {
        id: "grpc-scaffold",
        name: "gRPC / Protobuf Scaffold",
        icon: "📡",
        category: "generation",
        description: "Generate protobuf definitions and gRPC services",
        promptPrefix:
          "[SKILL: grpc-scaffold] Scaffold gRPC services. Include: (1) .proto file with messages, services, and enums, (2) Server implementation with proper error handling, (3) Client stub generation, (4) Interceptors for auth/logging, (5) Health check service, (6) Reflection for debugging. Follow gRPC best practices.",
      },
      {
        id: "monorepo-scaffold",
        name: "Monorepo Setup",
        icon: "🏛️",
        category: "generation",
        description: "Set up Turborepo/Nx/pnpm workspace",
        promptPrefix:
          "[SKILL: monorepo-scaffold] Set up a monorepo architecture. Include: (1) pnpm workspaces or Turborepo config, (2) shared packages (tsconfig, eslint, types), (3) app and package structure, (4) build pipeline with caching, (5) cross-package dependency management, (6) CI/CD for selective builds.",
      },
      {
        id: "microservice-scaffold",
        name: "Microservice Scaffold",
        icon: "🧩",
        category: "generation",
        description: "Generate microservice with API gateway",
        promptPrefix:
          "[SKILL: microservice-scaffold] Scaffold a microservice. Include: (1) Service with its own database, (2) API gateway routing, (3) Inter-service communication (REST/gRPC/message queue), (4) Service discovery, (5) Circuit breaker pattern, (6) Distributed tracing, (7) Docker + k8s manifests.",
      },
      {
        id: "cron-worker",
        name: "Background Worker / Cron",
        icon: "⏰",
        category: "generation",
        description: "Generate background job processing",
        promptPrefix:
          "[SKILL: cron-worker] Generate a background job processor. Include: (1) Job queue setup (Bull/Agenda/Sidekiq), (2) Worker with retry logic and exponential backoff, (3) Job scheduling (cron expressions), (4) Dead letter queue for failed jobs, (5) Job status tracking, (6) Graceful shutdown, (7) Monitoring dashboard endpoint.",
      },
    ],
  },

  // ================================================================
  // 🔧 REFACTORING & CLEANUP
  // ================================================================
  {
    id: "refactoring",
    name: "Refactoring",
    icon: "🔧",
    skills: [
      {
        id: "extract-function",
        name: "Extract Function",
        icon: "✂️",
        category: "refactoring",
        description: "Break large functions into smaller ones",
        promptPrefix:
          "[SKILL: extract-function] Refactor by extracting functions. Identify functions longer than 20 lines. Extract cohesive blocks into well-named helpers. Ensure single responsibility. Preserve all existing behavior.",
      },
      {
        id: "simplify-code",
        name: "Simplify Code",
        icon: "✨",
        category: "refactoring",
        description: "Reduce complexity and improve readability",
        promptPrefix:
          "[SKILL: simplify-code] Simplify the code. Look for: (1) deeply nested conditionals → early returns, (2) complex expressions → named variables, (3) duplicate logic → shared utilities, (4) verbose patterns → concise alternatives (optional chaining, nullish coalescing). Maintain identical behavior.",
      },
      {
        id: "add-types",
        name: "Type Annotations",
        icon: "📝",
        category: "refactoring",
        description: "Add strict TypeScript types",
        promptPrefix:
          "[SKILL: add-types] Add comprehensive TypeScript types. Type all parameters, return values, variables, and class properties. Replace `any` with proper types. Add discriminated unions. Enable strict mode checks.",
      },
      {
        id: "error-handling",
        name: "Error Handling",
        icon: "🚨",
        category: "refactoring",
        description: "Add proper error handling patterns",
        promptPrefix:
          "[SKILL: error-handling] Add comprehensive error handling. Wrap risky operations in try/catch. Add proper error types/classes. Include error logging. Handle async errors. Add retry logic where appropriate. Never swallow errors silently.",
      },
      {
        id: "dead-code",
        name: "Remove Dead Code",
        icon: "🗑️",
        category: "refactoring",
        description: "Find and remove unused code",
        promptPrefix:
          "[SKILL: dead-code] Identify and remove dead code. Find: (1) unused imports, (2) unreachable paths, (3) unused variables/functions, (4) commented-out code, (5) deprecated API usage. Remove each with explanation.",
      },
      {
        id: "circuit-breaker",
        name: "Circuit Breaker Pattern",
        icon: "🔌",
        category: "refactoring",
        description: "Add circuit breaker for external calls",
        promptPrefix:
          "[SKILL: circuit-breaker] Implement the circuit breaker pattern for external service calls. Include: (1) Three states: Closed, Open, Half-Open, (2) Failure threshold to trip, (3) Timeout to attempt reset, (4) Fallback behavior when open, (5) Metrics/logging for observability, (6) Configurable thresholds.",
      },
      {
        id: "graceful-shutdown",
        name: "Graceful Shutdown",
        icon: "🛑",
        category: "refactoring",
        description: "Add clean shutdown handling",
        promptPrefix:
          "[SKILL: graceful-shutdown] Implement graceful shutdown. Handle SIGTERM/SIGINT signals. Drain active connections, finish in-flight requests, close database pools, flush logs, and exit cleanly with proper timeouts.",
      },
      {
        id: "composition-patterns",
        name: "Composition Patterns",
        icon: "🧱",
        category: "refactoring",
        description: "Replace boolean props with compound components",
        promptPrefix:
          "[SKILL: composition-patterns] Refactor boolean prop hell into compound component patterns. Replace: <Component propA propB propC /> with: <Component><Component.Header /><Component.Body /><Component.Footer /></Component>. Use React context for shared state between compound parts.",
      },
    ],
  },

  // ================================================================
  // 🎨 FRONTEND & UI
  // ================================================================
  {
    id: "frontend",
    name: "Frontend & UI",
    icon: "🎨",
    skills: [
      {
        id: "frontend-design",
        name: "Frontend Design",
        icon: "🖼️",
        category: "frontend",
        description: "Production-grade UI (not generic AI slop)",
        promptPrefix:
          "[SKILL: frontend-design] Create bold, production-grade UI — not generic AI slop. Use: (1) Consistent spacing scale (4px base), (2) Purposeful color palette (not rainbow), (3) Typography hierarchy (max 3 font sizes per component), (4) Meaningful animations (ease curves, not linear), (5) Responsive design (mobile-first), (6) Dark mode support. Reference Stripe/Vercel/Linear for inspiration.",
      },
      {
        id: "react-best-practices",
        name: "React Best Practices",
        icon: "⚛️",
        category: "frontend",
        description: "57 performance rules for React/Next.js",
        promptPrefix:
          "[SKILL: react-best-practices] Apply React performance best practices: (1) Memoize expensive computations with useMemo, (2) Use useCallback for stable callbacks, (3) Avoid inline objects/arrays in JSX, (4) Code-split with dynamic imports, (5) Use React.lazy for routes, (6) Avoid re-renders with React.memo, (7) Use ref for mutable values, (8) Prefer useEffect over componentDidMount patterns, (9) Use Suspense for data fetching, (10) Server Components where possible.",
      },
      {
        id: "nextjs-app-router",
        name: "Next.js App Router",
        icon: "▲",
        category: "frontend",
        description: "App Router, Server Components, streaming",
        promptPrefix:
          "[SKILL: nextjs-app-router] Build with Next.js 14+ App Router patterns: (1) Server Components by default, (2) Client Components only when needed ('use client'), (3) Parallel routes for complex layouts, (4) Intercepting routes for modals, (5) Streaming with Suspense boundaries, (6) Route Handlers for API, (7) Metadata API for SEO, (8) Server Actions for mutations.",
      },
      {
        id: "wcag-accessibility",
        name: "WCAG 2.2 Accessibility",
        icon: "♿",
        category: "frontend",
        description: "Full WCAG 2.2 audit and remediation",
        promptPrefix:
          "[SKILL: wcag-accessibility] Conduct WCAG 2.2 AA audit. Check: (1) Semantic HTML elements, (2) ARIA roles/labels/live regions, (3) Keyboard navigation (Tab, Enter, Escape, Arrow keys), (4) Focus visible indicators, (5) Color contrast 4.5:1 minimum, (6) Screen reader announcements, (7) Reduced motion support, (8) Form error associations, (9) Touch target size 44x44px. Fix all violations.",
      },
      {
        id: "web-typography",
        name: "Web Typography",
        icon: "🔤",
        category: "frontend",
        description: "Readable, accessible text styling",
        promptPrefix:
          "[SKILL: web-typography] Optimize typography for readability: (1) Line height 1.5-1.7 for body, (2) Measure 45-75 characters per line, (3) Paragraph spacing > line height, (4) Font size ≥16px base, (5) Proper heading hierarchy (h1→h2→h3), (6) Responsive font sizes with clamp(), (7) System font stack or optimized web fonts, (8) Dark mode text contrast.",
      },
      {
        id: "animation-patterns",
        name: "Animation Patterns",
        icon: "🎬",
        category: "frontend",
        description: "Purposeful motion design",
        promptPrefix:
          "[SKILL: animation-patterns] Add purposeful animations: (1) Use CSS transitions for simple state changes, (2) Use requestAnimationFrame for complex sequences, (3) Respect prefers-reduced-motion, (4) Keep durations 150-400ms, (5) Use ease-out for entrances, ease-in for exits, (6) Animate transform/opacity only (GPU-accelerated), (7) Stagger child animations, (8) Use CSS @keyframes for loops.",
      },
      {
        id: "design-system",
        name: "Design System Components",
        icon: "🎨",
        category: "frontend",
        description: "Build reusable component library",
        promptPrefix:
          "[SKILL: design-system] Build a design system component library. Include: (1) Token system (colors, spacing, typography), (2) Primitive components (Button, Input, Card), (3) Composite components (DataTable, Modal, Toast), (4) Composition patterns (asChild, render props), (5) Variant system (cva/tailwind-variants), (6) Accessibility built-in, (7) Storybook stories, (8) TypeScript prop interfaces.",
      },
      {
        id: "remotion-video",
        name: "Remotion Video Generation",
        icon: "🎥",
        category: "frontend",
        description: "Programmatic video with React (Remotion)",
        promptPrefix:
          "[SKILL: remotion-video] Build programmatic video with Remotion. Include: (1) Composition with FPS and duration, (2) Sequence-based animations, (3) interpolate() for smooth transitions, (4) spring() for physics-based motion, (5) Audio/video sync, (6) Dynamic data-driven content, (7) Render to MP4/WebM, (8) Preview in browser.",
      },
    ],
  },

  // ================================================================
  // 🌐 WEB & RESEARCH
  // ================================================================
  {
    id: "web-research",
    name: "Web & Research",
    icon: "🌐",
    skills: [
      {
        id: "web-search",
        name: "Web Search",
        icon: "🔎",
        category: "web-research",
        description: "Search the web for information",
        promptPrefix:
          "[SKILL: web-search] Search the web for current information. Find official docs, blog posts, and community answers. Provide citations with URLs.",
      },
      {
        id: "doc-lookup",
        name: "Documentation Lookup",
        icon: "📚",
        category: "web-research",
        description: "Find official documentation",
        promptPrefix:
          "[SKILL: doc-lookup] Look up official documentation for relevant libraries/frameworks. Find exact API signatures, config options, and version-specific changes. Cite source URLs.",
      },
      {
        id: "lib-compare",
        name: "Library Comparison",
        icon: "⚖️",
        category: "web-research",
        description: "Compare libraries and frameworks",
        promptPrefix:
          "[SKILL: lib-compare] Research and compare libraries for this use case. Create a comparison table: (1) features, (2) bundle size, (3) performance, (4) community, (5) maintenance, (6) TypeScript support. Recommend best option.",
      },
      {
        id: "stackoverflow",
        name: "Stack Overflow Research",
        icon: "💡",
        category: "web-research",
        description: "Find community solutions",
        promptPrefix:
          "[SKILL: stackoverflow] Search developer forums for solutions. Find highest-voted answers, check if up-to-date, adapt to this project's context.",
      },
      {
        id: "webapp-testing",
        name: "Webapp Browser Testing",
        icon: "🌐",
        category: "web-research",
        description: "Test local app in real browser (Playwright)",
        promptPrefix:
          "[SKILL: webapp-testing] Test the local webapp in a real browser using Playwright. Include: (1) Start dev server, (2) Navigate to each route, (3) Test interactive elements, (4) Capture screenshots, (5) Check console for errors, (6) Test responsive breakpoints, (7) Verify form submissions, (8) Check loading states.",
      },
      {
        id: "firecrawl-scrape",
        name: "Web Scraping (Firecrawl)",
        icon: "🕷️",
        category: "web-research",
        description: "Scrape and extract web content",
        promptPrefix:
          "[SKILL: firecrawl-scrape] Scrape the target URL and extract structured content. Use markdown extraction for docs, structured data extraction for product pages, and batch crawling for multiple URLs. Handle JavaScript-rendered content, pagination, and rate limiting.",
      },
    ],
  },

  // ================================================================
  // 🔒 SECURITY
  // ================================================================
  {
    id: "security",
    name: "Security",
    icon: "🔒",
    skills: [
      {
        id: "secret-scanner",
        name: "Secret Scanner",
        icon: "🔑",
        category: "security",
        description: "Find exposed secrets and API keys",
        promptPrefix:
          "[SKILL: secret-scanner] Scan for exposed secrets: (1) hardcoded API keys, (2) passwords in source, (3) .env in git, (4) private keys, (5) tokens in configs, (6) connection strings. For each finding, suggest remediation.",
      },
      {
        id: "sanitize-input",
        name: "Input Sanitization",
        icon: "🧼",
        category: "security",
        description: "Add input validation and sanitization",
        promptPrefix:
          "[SKILL: sanitize-input] Add input sanitization. Validate all inputs at API boundaries. Use Zod schemas. Sanitize HTML output to prevent XSS. Rate-limit endpoints. Add CSRF protection. Log suspicious inputs.",
      },
      {
        id: "auth-check",
        name: "Auth & Authorization Check",
        icon: "🔐",
        category: "security",
        description: "Review auth implementation",
        promptPrefix:
          "[SKILL: auth-check] Review auth: (1) session management, (2) password hashing (bcrypt/argon2), (3) JWT validation, (4) RBAC, (5) session fixation, (6) privilege escalation, (7) OAuth flow security, (8) API key rotation.",
      },
      {
        id: "semgrep-scan",
        name: "Semgrep SAST Scan",
        icon: "🔎",
        category: "security",
        description: "Static analysis with Semgrep rules",
        promptPrefix:
          "[SKILL: semgrep-scan] Run Semgrep-style static analysis. Check for: (1) injection vulnerabilities (SQL, command, template), (2) insecure cryptography, (3) hardcoded credentials, (4) path traversal, (5) SSRF, (6) insecure deserialization, (7) missing rate limiting. Map to OWASP and CWE.",
      },
      {
        id: "supply-chain-audit",
        name: "Supply Chain Security",
        icon: "⛓️",
        category: "security",
        description: "Audit npm/pip dependencies for risks",
        promptPrefix:
          "[SKILL: supply-chain-audit] Audit supply chain security: (1) Check for typosquatting in package names, (2) Verify package publisher reputation, (3) Check for postinstall scripts, (4) Review dependency tree for transitive risks, (5) Lock file integrity, (6) Verify checksums/signatures, (7) Check for known malicious packages.",
      },
      {
        id: "crypto-review",
        name: "Cryptography Review",
        icon: "🔏",
        category: "security",
        description: "Review crypto implementation",
        promptPrefix:
          "[SKILL: crypto-review] Review cryptographic implementation: (1) Are you using proven libraries (not roll-your-own)? (2) Correct algorithm choices (AES-256-GCM not ECB)? (3) Proper key derivation (PBKDF2/argon2 not MD5)? (4) Secure random generation (crypto.randomBytes)? (5) TLS configuration, (6) Certificate validation.",
      },
    ],
  },

  // ================================================================
  // 💎 QUALITY & STANDARDS
  // ================================================================
  {
    id: "quality",
    name: "Quality & Standards",
    icon: "💎",
    skills: [
      {
        id: "lint-check",
        name: "Lint & Format",
        icon: "📏",
        category: "quality",
        description: "Run linter and fix issues",
        promptPrefix:
          "[SKILL: lint-check] Run linter (ESLint/prettier/biome) and fix all issues. Auto-fix what's possible, manually fix the rest. Ensure code passes all rules.",
      },
      {
        id: "type-check",
        name: "Type Check",
        icon: "🔷",
        category: "quality",
        description: "Fix TypeScript errors properly",
        promptPrefix:
          "[SKILL: type-check] Run tsc --noEmit and fix all TypeScript errors. Understand each error's root cause and fix properly — never use `as any`. Ensure strict types.",
      },
      {
        id: "naming-review",
        name: "Naming Review",
        icon: "🏷️",
        category: "quality",
        description: "Improve variable and function names",
        promptPrefix:
          "[SKILL: naming-review] Review naming: (1) single-letter → descriptive, (2) abbreviations → full words, (3) booleans → is/has/can, (4) callbacks → handle/onChange, (5) generic → specific. Follow project conventions.",
      },
      {
        id: "caveman-mode",
        name: "Caveman Mode (Token Saver)",
        icon: "🪨",
        category: "quality",
        description: "Cut output tokens by 65%, keep all facts",
        promptPrefix:
          "[SKILL: caveman] Strip all narration, filler, and prose. Output only: code, bullet points, and essential technical facts. No 'Here's what I did', no 'Let me explain', no transitions. Maximum information density. Cut token usage by 65%.",
      },
      {
        id: "commit-conventions",
        name: "Conventional Commits",
        icon: "📝",
        category: "quality",
        description: "Format commits following conventional commits spec",
        promptPrefix:
          "[SKILL: commit-conventions] Generate commit messages following Conventional Commits (conventionalcommits.org). Format: type(scope): description. Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build. Body explains WHY not WHAT. Breaking changes marked with !.",
      },
      {
        id: "context-mode",
        name: "Context Mode (Noise Filter)",
        icon: "🧹",
        category: "quality",
        description: "Filter shell output noise from context",
        promptPrefix:
          "[SKILL: context-mode] Filter shell output noise. When reviewing terminal/command output: (1) Strip ANSI color codes, (2) Remove progress bars and spinners, (3) Extract only errors/warnings/summaries, (4) Collapse verbose output to key metrics, (5) Preserve actual data and results.",
      },
    ],
  },

  // ================================================================
  // 🧪 TESTING & QA
  // ================================================================
  {
    id: "testing",
    name: "Testing & QA",
    icon: "🧪",
    skills: [
      {
        id: "unit-test-gen",
        name: "Unit Test Generator",
        icon: "🔬",
        category: "testing",
        description: "Generate unit tests with edge cases",
        promptPrefix:
          "[SKILL: unit-test-gen] Generate unit tests. For each function: (1) Happy path test, (2) Null/undefined inputs, (3) Empty collections, (4) Boundary values, (5) Error conditions, (6) Type coercion edge cases. Use the project's test framework (jest/vitest/mocha). Mock external dependencies.",
      },
      {
        id: "integration-test",
        name: "Integration Test Generator",
        icon: "🔗",
        category: "testing",
        description: "Generate integration tests for APIs",
        promptPrefix:
          "[SKILL: integration-test] Generate integration tests for API endpoints. Include: (1) Request/response validation, (2) Auth middleware testing, (3) Database state verification, (4) Error response formats, (5) Rate limiting behavior, (6) CORS headers, (7) Content negotiation. Use supertest/axios with test database.",
      },
      {
        id: "e2e-playwright",
        name: "E2E Playwright Tests",
        icon: "🎭",
        category: "testing",
        description: "Generate end-to-end browser tests",
        promptPrefix:
          "[SKILL: e2e-playwright] Generate Playwright E2E tests. Include: (1) Page navigation tests, (2) Form submission flows, (3) Auth login/logout, (4) Responsive viewport tests, (5) Network request mocking, (6) Screenshot comparisons, (7) Accessibility checks, (8) Download/upload handling.",
      },
      {
        id: "property-test",
        name: "Property-Based Testing",
        icon: "🎲",
        category: "testing",
        description: "Generate property-based tests (fast-check)",
        promptPrefix:
          "[SKILL: property-test] Generate property-based tests using fast-check or similar. Define properties that should always hold: (1) Serialization round-trips, (2) Sort produces ordered output, (3) Filter reduces count, (4) Parse/unparse round-trips, (5) Idempotency of operations. Generate random inputs to find edge cases.",
      },
      {
        id: "load-test",
        name: "Load & Stress Testing",
        icon: "📈",
        category: "testing",
        description: "Generate load test scripts (k6/artillery)",
        promptPrefix:
          "[SKILL: load-test] Generate load test scripts. Include: (1) Ramp-up from 1 to 100 concurrent users, (2) Steady state at target load, (3) Spike test (10x traffic burst), (4) Soak test (sustained load for hours), (5) Key metrics (p50/p95/p99 latency, error rate, throughput), (6) Threshold assertions.",
      },
      {
        id: "mutation-test",
        name: "Mutation Testing",
        icon: "🧬",
        category: "testing",
        description: "Check test quality with mutation testing",
        promptPrefix:
          "[SKILL: mutation-test] Run mutation testing to evaluate test quality. Introduce small code changes (mutants) and check if tests catch them. Identify: (1) Equivalent mutants (safe to ignore), (2) Survived mutants (tests need strengthening), (3) Missing test cases. Aim for >80% mutation score.",
      },
    ],
  },

  // ================================================================
  // 🚀 DEVOPS & INFRASTRUCTURE
  // ================================================================
  {
    id: "devops",
    name: "DevOps & Infrastructure",
    icon: "🚀",
    skills: [
      {
        id: "kubernetes-manifests",
        name: "Kubernetes Manifests",
        icon: "☸️",
        category: "devops",
        description: "Generate k8s deployment, service, ingress",
        promptPrefix:
          "[SKILL: kubernetes] Generate Kubernetes manifests: (1) Deployment with resource limits, liveness/readiness probes, (2) Service with proper selector, (3) Ingress with TLS, (4) ConfigMap/Secret, (5) HPA for auto-scaling, (6) NetworkPolicy, (7) PodDisruptionBudget. Follow k8s best practices.",
      },
      {
        id: "terraform-module",
        name: "Terraform Module",
        icon: "🏗️",
        category: "devops",
        description: "Generate Terraform IaC modules",
        promptPrefix:
          "[SKILL: terraform] Generate Terraform module: (1) variables.tf with types and validation, (2) main.tf with resources, (3) outputs.tf with sensitive outputs, (4) versions.tf with provider constraints, (5) README with usage examples, (6) Workspaces for env separation, (7) State locking config.",
      },
      {
        id: "cicd-pipeline",
        name: "CI/CD Pipeline",
        icon: "🔄",
        category: "devops",
        description: "GitHub Actions / GitLab CI pipeline",
        promptPrefix:
          "[SKILL: cicd-pipeline] Generate CI/CD pipeline. Include: (1) Lint + typecheck stage, (2) Unit test stage with coverage, (3) Integration test stage, (4) Build stage with caching, (5) Deploy stage with environment protection, (6) Secret management, (7) Concurrency controls, (8) Status badges.",
      },
      {
        id: "gitops-workflow",
        name: "GitOps (ArgoCD/Flux)",
        icon: "📋",
        category: "devops",
        description: "Declarative K8s deployment with GitOps",
        promptPrefix:
          "[SKILL: gitops] Set up GitOps workflow: (1) ArgoCD Application/Flux Kustomization, (2) Git repository structure for envs, (3) Image automation for updates, (4) Sync hooks for migrations, (5) Rollback strategy, (6) Multi-cluster config, (7) Secret management with Sealed Secrets/SOPS.",
      },
      {
        id: "observability-stack",
        name: "Observability (OpenTelemetry)",
        icon: "📊",
        category: "devops",
        description: "Add tracing, metrics, and logging",
        promptPrefix:
          "[SKILL: observability] Add OpenTelemetry instrumentation: (1) Distributed tracing with spans, (2) Custom metrics (counters, histograms), (3) Structured logging with correlation IDs, (4) Health check endpoints, (5) Dashboard queries (Prometheus/Grafana), (6) Alert rules, (7) Log aggregation config.",
      },
      {
        id: "istio-service-mesh",
        name: "Istio Service Mesh",
        icon: "🕸️",
        category: "devops",
        description: "Configure Istio traffic management",
        promptPrefix:
          "[SKILL: istio] Configure Istio: (1) VirtualService routing, (2) DestinationRule load balancing, (3) Canary deployments with traffic shifting, (4) Circuit breaker configuration, (5) mTLS enforcement, (6) Rate limiting, (7) Fault injection for chaos testing.",
      },
      {
        id: "nginx-config",
        name: "Nginx Configuration",
        icon: "⚙️",
        category: "devops",
        description: "Generate nginx reverse proxy config",
        promptPrefix:
          "[SKILL: nginx] Generate nginx config: (1) Reverse proxy with upstream, (2) SSL/TLS with Let's Encrypt, (3) Gzip/Brotli compression, (4) Security headers (CSP, HSTS, X-Frame), (5) Rate limiting, (6) WebSocket proxying, (7) Caching strategy, (8) Access/error logging.",
      },
    ],
  },

  // ================================================================
  // 📱 MOBILE & CROSS-PLATFORM
  // ================================================================
  {
    id: "mobile",
    name: "Mobile & Cross-Platform",
    icon: "📱",
    skills: [
      {
        id: "react-native-component",
        name: "React Native Component",
        icon: "⚛️",
        category: "mobile",
        description: "Generate cross-platform RN components",
        promptPrefix:
          "[SKILL: react-native] Generate React Native component: (1) StyleSheet with responsive sizing, (2) Platform-specific code (Platform.OS), (3) Accessibility props, (4) Performance (FlatList, useMemo), (5) Navigation integration, (6) Dark mode support, (7) TypeScript props interface.",
      },
      {
        id: "flutter-widget",
        name: "Flutter Widget",
        icon: "🐦",
        category: "mobile",
        description: "Generate Flutter widgets with state management",
        promptPrefix:
          "[SKILL: flutter] Generate Flutter widget: (1) StatelessWidget or StatefulWidget as needed, (2) Proper build method structure, (3) Theme integration, (4) Responsive layout with MediaQuery, (5) Animation controllers, (6) State management (Provider/Riverpod/Bloc), (7) Unit/widget tests.",
      },
      {
        id: "expo-setup",
        name: "Expo / React Native Setup",
        icon: "📲",
        category: "mobile",
        description: "Set up Expo project with navigation",
        promptPrefix:
          "[SKILL: expo-setup] Set up Expo project: (1) Expo Router for file-based navigation, (2) Auth flow (Expo AuthSession), (3) Push notifications (Expo Notifications), (4) Camera/Media (Expo AV), (5) Secure storage (Expo SecureStore), (6) EAS Build config, (7) Deep linking.",
      },
    ],
  },

  // ================================================================
  // 📊 DATA & AI/ML
  // ================================================================
  {
    id: "data-ai",
    name: "Data & AI/ML",
    icon: "📊",
    skills: [
      {
        id: "sql-optimization",
        name: "SQL Query Optimization",
        icon: "🗄️",
        category: "data-ai",
        description: "Optimize slow SQL queries",
        promptPrefix:
          "[SKILL: sql-optimize] Optimize SQL queries: (1) Add missing indexes (EXPLAIN ANALYZE), (2) Eliminate N+1 with JOINs/subqueries, (3) Use CTEs for complex logic, (4) Partition large tables, (5) Optimize SELECT columns (no SELECT *), (6) Add query plan analysis, (7) Implement connection pooling.",
      },
      {
        id: "data-pipeline",
        name: "Data Pipeline (ETL)",
        icon: "🔀",
        category: "data-ai",
        description: "Generate ETL/ELT data pipeline",
        promptPrefix:
          "[SKILL: data-pipeline] Generate data pipeline: (1) Extract from source (API/DB/file), (2) Transform (validate, clean, aggregate), (3) Load to destination, (4) Error handling and dead letter queue, (5) Idempotent operations, (6) Incremental processing, (7) Data quality checks, (8) Monitoring and alerting.",
      },
      {
        id: "ml-pipeline",
        name: "ML Pipeline (MLOps)",
        icon: "🤖",
        category: "data-ai",
        description: "End-to-end ML training pipeline",
        promptPrefix:
          "[SKILL: ml-pipeline] Build MLOps pipeline: (1) Data versioning (DVC), (2) Feature engineering, (3) Model training with hyperparameter tuning, (4) Evaluation metrics and reporting, (5) Model registry, (6) A/B testing framework, (7) Model monitoring and drift detection, (8) Automated retraining triggers.",
      },
      {
        id: "vector-search",
        name: "Vector Search / RAG",
        icon: "🧭",
        category: "data-ai",
        description: "Build RAG pipeline with vector DB",
        promptPrefix:
          "[SKILL: vector-rag] Build RAG pipeline: (1) Document chunking strategy, (2) Embedding generation (OpenAI/Cohere/local), (3) Vector DB setup (Pinecone/Weaviate/pgvector), (4) Hybrid search (semantic + keyword), (5) Reranking, (6) Context window assembly, (7) Citation tracking, (8) Evaluation (faithfulness, relevance).",
      },
      {
        id: "risk-metrics",
        name: "Financial Risk Metrics",
        icon: "📈",
        category: "data-ai",
        description: "VaR, Sharpe, Sortino, drawdown analysis",
        promptPrefix:
          "[SKILL: risk-metrics] Calculate portfolio risk metrics: (1) Value at Risk (VaR) - parametric and historical, (2) Conditional VaR (CVaR/Expected Shortfall), (3) Sharpe Ratio, (4) Sortino Ratio, (5) Maximum Drawdown, (6) Beta and Alpha, (7) Correlation matrix, (8) Monte Carlo simulation.",
      },
    ],
  },

  // ================================================================
  // 🎬 MEDIA & CONTENT
  // ================================================================
  {
    id: "media",
    name: "Media & Content",
    icon: "🎬",
    skills: [
      {
        id: "pdf-generator",
        name: "PDF / Document Generator",
        icon: "📄",
        category: "media",
        description: "Generate PDFs, DOCX, XLSX, PPTX",
        promptPrefix:
          "[SKILL: doc-gen] Generate documents programmatically. For PDFs: use pdfkit/puppeteer with proper margins, headers, page numbers. For DOCX: use docx library with styles. For XLSX: use exceljs with formatting. For PPTX: use pptxgenjs with layouts. Include proper fonts, colors, and branding.",
      },
      {
        id: "email-templates",
        name: "Email Template Generator",
        icon: "📧",
        category: "media",
        description: "Generate responsive HTML email templates",
        promptPrefix:
          "[SKILL: email-template] Generate responsive HTML email: (1) Table-based layout for email client compatibility, (2) Inline CSS (most clients strip <style>), (3) Mobile-responsive with media queries, (4) Dark mode support, (5) Fallback fonts, (6) Image alt text, (7) Unsubscribe link, (8) Tested across Gmail/Outlook/Apple Mail.",
      },
      {
        id: "og-image-generator",
        name: "OG Image / Social Card",
        icon: "🖼️",
        category: "media",
        description: "Generate Open Graph images dynamically",
        promptPrefix:
          "[SKILL: og-image] Generate dynamic OG images: (1) Use satori/vercel-og for JSX-to-SVG, (2) Branded template with logo, (3) Dynamic title/subtitle from props, (4) Gradient backgrounds, (5) Proper dimensions (1200x630), (6) Font loading (Inter/JetBrains Mono), (7) Cache headers for performance.",
      },
      {
        id: "icon-system",
        name: "SVG Icon System",
        icon: "⭐",
        category: "media",
        description: "Generate optimized SVG icon library",
        promptPrefix:
          "[SKILL: icon-system] Create SVG icon system: (1) Consistent 24x24 viewBox, (2) Stroke-based (not filled) for consistency, (3) React component wrappers with size/color props, (4) Tree-shakeable exports, (5) Fallback for missing icons, (6) Accessibility (aria-hidden for decorative), (7) Sprite sheet option for non-React.",
      },
    ],
  },

  // ================================================================
  // 💰 BUSINESS & MARKETING
  // ================================================================
  {
    id: "business",
    name: "Business & Marketing",
    icon: "💰",
    skills: [
      {
        id: "landing-page",
        name: "Landing Page Copy",
        icon: "🚀",
        category: "business",
        description: "Write high-converting landing page",
        promptPrefix:
          "[SKILL: landing-page] Write a high-converting landing page. Structure: (1) Hero with clear value prop (< 10 words), (2) Problem statement (pain points), (3) Solution (how it works), (4) Social proof (testimonials, metrics), (5) Feature grid (3-6 key features), (6) Pricing (clear tiers), (7) FAQ, (8) CTA with urgency. Use Corey Haines' growth principles.",
      },
      {
        id: "seo-copywriting",
        name: "SEO Copywriting",
        icon: "🔎",
        category: "business",
        description: "Optimize content for search engines",
        promptPrefix:
          "[SKILL: seo-copy] Optimize content for SEO: (1) Keyword research and placement, (2) Title tag (< 60 chars), (3) Meta description (< 155 chars), (4) H1/H2/H3 structure, (5) Internal linking, (6) Image alt text, (7) Schema markup, (8) Readability (Flesch score > 60), (9) URL structure.",
      },
      {
        id: "api-documentation",
        name: "API Documentation (OpenAPI)",
        icon: "📖",
        category: "business",
        description: "Generate OpenAPI/Swagger spec",
        promptPrefix:
          "[SKILL: api-docs] Generate OpenAPI 3.1 specification: (1) Info and servers, (2) Paths with all methods, (3) Request/response schemas, (4) Authentication (Bearer, API key, OAuth2), (5) Error responses, (6) Examples for each endpoint, (7) Tags for grouping, (8) Generate interactive docs with Redoc/Swagger UI.",
      },
      {
        id: "changelog-generator",
        name: "Changelog Generator",
        icon: "📋",
        category: "business",
        description: "Generate changelog from git commits",
        promptPrefix:
          "[SKILL: changelog] Generate a changelog from recent git commits. Group by: Features, Bug Fixes, Breaking Changes, Documentation, Dependencies. Use conventional commit format. Link to PRs/issues. Include migration notes for breaking changes. Format for both humans and machines (keepachangelog.com).",
      },
    ],
  },

  // ================================================================
  // 🔗 INTEGRATIONS & MCP
  // ================================================================
  {
    id: "integrations",
    name: "Integrations & APIs",
    icon: "🔗",
    skills: [
      {
        id: "stripe-integration",
        name: "Stripe Payment Integration",
        icon: "💳",
        category: "integrations",
        description: "Full Stripe checkout, webhooks, subscription",
        promptPrefix:
          "[SKILL: stripe] Implement Stripe integration: (1) Checkout session creation, (2) Customer portal, (3) Webhook handling with signature verification, (4) Subscription management (create/cancel/upgrade), (5) Invoice generation, (6) Idempotency keys, (7) Test mode with test cards, (8) Error handling for declined cards.",
      },
      {
        id: "oauth-integration",
        name: "OAuth 2.0 Integration",
        icon: "🔑",
        category: "integrations",
        description: "Implement OAuth 2.0 flow (Google, GitHub, etc.)",
        promptPrefix:
          "[SKILL: oauth] Implement OAuth 2.0: (1) Authorization code flow with PKCE, (2) Token exchange and refresh, (3) Scope management, (4) State parameter for CSRF protection, (5) Secure token storage, (6) Token refresh logic, (7) Account linking, (8) Error handling for revoked/expired tokens.",
      },
      {
        id: "webhook-handler",
        name: "Webhook Handler",
        icon: "🪝",
        category: "integrations",
        description: "Robust webhook receiver with verification",
        promptPrefix:
          "[SKILL: webhook] Build robust webhook handler: (1) Signature verification (HMAC-SHA256), (2) Idempotency (dedup by event ID), (3) Async processing queue, (4) Retry with exponential backoff, (5) Event logging and audit trail, (6) Dead letter queue, (7) Health check endpoint, (8) Replaying missed events.",
      },
      {
        id: "email-service",
        name: "Email Service (SendGrid/Resend)",
        icon: "📧",
        category: "integrations",
        description: "Integrate transactional email service",
        promptPrefix:
          "[SKILL: email-service] Integrate transactional email: (1) Template system with variables, (2) Send with retry logic, (3) Bounce/complaint handling, (4) Unsubscribe management, (5) Email verification, (6) Rate limiting, (7) Analytics (open/click tracking), (8) Test mode for development.",
      },
      {
        id: "chat-widget",
        name: "Real-Time Chat (WebSocket)",
        icon: "💬",
        category: "integrations",
        description: "Implement real-time chat with WebSocket",
        promptPrefix:
          "[SKILL: websocket-chat] Implement real-time chat: (1) WebSocket server with Socket.io/ws, (2) Room/channel management, (3) Typing indicators, (4) Read receipts, (5) Message persistence, (6) Reconnection handling, (7) Presence tracking, (8) Rate limiting per user, (9) File upload via WS.",
      },
    ],
  },

  // ================================================================
  // 🧠 ADVANCED PATTERNS
  // ================================================================
  {
    id: "advanced",
    name: "Advanced Patterns",
    icon: "🧠",
    skills: [
      {
        id: "event-sourcing",
        name: "Event Sourcing / CQRS",
        icon: "📜",
        category: "advanced",
        description: "Implement event sourcing with CQRS",
        promptPrefix:
          "[SKILL: event-sourcing] Implement event sourcing: (1) Event store schema, (2) Command handlers that emit events, (3) Event handlers that update projections, (4) Snapshot optimization, (5) Event versioning and upcasting, (6) Read model queries, (7) Rebuild projections from events, (8) Audit trail from event log.",
      },
      {
        id: "saga-pattern",
        name: "Saga / Choreography Pattern",
        icon: "🔄",
        category: "advanced",
        description: "Distributed transactions with sagas",
        promptPrefix:
          "[SKILL: saga] Implement saga pattern: (1) Define saga steps with compensating transactions, (2) Orchestrator or choreography approach, (3) Timeout handling, (4) Retry with backoff, (5) Compensating actions for rollback, (6) Saga state persistence, (7) Dead letter queue for failed sagas, (8) Monitoring dashboard.",
      },
      {
        id: "leader-election",
        name: "Leader Election",
        icon: "👑",
        category: "advanced",
        description: "Distributed leader election for singletons",
        promptPrefix:
          "[SKILL: leader-election] Implement leader election: (1) Database-based with advisory locks, (2) TTL-based lease with renewal, (3) Follower detection and failover, (4) Graceful abdication on shutdown, (5) Split-brain prevention, (6) Health check from followers, (7) Automatic re-election on leader failure.",
      },
      {
        id: "job-state-machine",
        name: "Job State Machine",
        icon: "⚙️",
        category: "advanced",
        description: "Model jobs as finite state machines",
        promptPrefix:
          "[SKILL: state-machine] Model this workflow as a finite state machine: (1) Define all states and transitions, (2) Guard conditions for each transition, (3) Side effects on state entry/exit, (4) Invalid transition handling, (5) Persisted state with recovery, (6) Visual state diagram, (7) Unit tests for all transitions.",
      },
      {
        id: "plugin-architecture",
        name: "Plugin Architecture",
        icon: "🔌",
        category: "advanced",
        description: "Build extensible plugin system",
        promptPrefix:
          "[SKILL: plugin-arch] Build a plugin architecture: (1) Plugin interface/type definition, (2) Plugin loader with sandboxing, (3) Hook system (before/after lifecycle events), (4) Plugin dependency resolution, (5) Configuration per plugin, (6) Hot-reload support, (7) Plugin marketplace/discovery, (8) Version compatibility checks.",
      },
      {
        id: "blue-green-deploy",
        name: "Blue-Green / Canary Deploy",
        icon: "🟢",
        category: "advanced",
        description: "Zero-downtime deployment strategies",
        promptPrefix:
          "[SKILL: blue-green] Implement zero-downtime deployment: (1) Blue-green with traffic switching, (2) Canary with percentage-based routing, (3) Health check gates, (4) Automatic rollback on failure, (5) Database migration compatibility, (6) Session affinity handling, (7) Smoke tests post-deploy, (8) Feature flags for gradual rollout.",
      },
      {
        id: "rate-limiter-advanced",
        name: "Advanced Rate Limiting",
        icon: "🚦",
        category: "advanced",
        description: "Token bucket, sliding window, adaptive",
        promptPrefix:
          "[SKILL: rate-limit-advanced] Implement advanced rate limiting: (1) Token bucket for burst handling, (2) Sliding window counter for accuracy, (3) Per-user and per-endpoint limits, (4) Redis-backed for distributed systems, (5) Adaptive limits based on server load, (6) Retry-After headers, (7) Rate limit dashboards, (8) Graceful degradation.",
      },
      {
        id: "idempotency",
        name: "Idempotency Framework",
        icon: "🔁",
        category: "advanced",
        description: "Make operations idempotent and safe to retry",
        promptPrefix:
          "[SKILL: idempotency] Make operations idempotent: (1) Idempotency keys for API requests, (2) Deduplication table with TTL, (3) Exactly-once processing semantics, (4) Database upserts instead of inserts, (5) Optimistic locking for concurrent updates, (6)幂等性 for webhook handlers, (7) Client-side retry safety.",
      },
    ],
  },
];

/** Flatten all skills into a single array */
export const ALL_SKILLS: Skill[] = SKILL_CATEGORIES.flatMap((cat) => cat.skills);

/** Find a skill by ID */
export function getSkillById(id: string): Skill | undefined {
  return ALL_SKILLS.find((s) => s.id === id);
}

/** Get skills matching a search query */
export function searchSkills(query: string): Skill[] {
  const lower = query.toLowerCase();
  return ALL_SKILLS.filter(
    (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower) ||
      s.category.toLowerCase().includes(lower)
  );
}

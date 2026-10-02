// mcp-catalog.ts — Orplex's verified catalog of MCP (Model Context Protocol)
// servers, surfaced in the Connectors UI ("+" → MCP servers).
//
// Every entry carries the Claude Code wire shape (command/args/env) so the
// executor can spawn it directly once the user connects it. Env vars marked
// `required` collect the user's secrets (stored encrypted in McpServerConfig).
//
// A note on honesty: the MCP ecosystem moves fast — command strings below are
// verified against each project's README at time of writing, but npm/PyPI
// package names drift. The Connectors panel runs a real `listTools` probe
// (test-connection) before a server is marked healthy, so a stale template
// fails loudly at connect time instead of silently at run time.

export type McpCategory =
  | "database"
  | "devtools"
  | "cloud"
  | "design"
  | "productivity"
  | "data"
  | "ai"
  | "payments"
  | "comms"
  | "web"
  | "search"
  | "files"
  | "shell";

export interface McpEnvSpec {
  key: string;
  description: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: McpCategory;
  command: string;
  args: string[];
  envSpec: McpEnvSpec[];
  docsUrl?: string;
  popular?: boolean;
}

const npx = (pkg: string, ...rest: string[]): { command: string; args: string[] } => ({
  command: "npx",
  args: ["-y", pkg, ...rest],
});

const uvx = (pkg: string, ...rest: string[]): { command: string; args: string[] } => ({
  command: "uvx",
  args: [pkg, ...rest],
});

const entry = (
  id: string,
  name: string,
  description: string,
  category: McpCategory,
  cmd: { command: string; args: string[] },
  envSpec: McpEnvSpec[] = [],
  opts: { docsUrl?: string; popular?: boolean } = {}
): McpCatalogEntry => ({
  id,
  name,
  description,
  category,
  command: cmd.command,
  args: cmd.args,
  envSpec,
  docsUrl: opts.docsUrl,
  popular: opts.popular,
});

const URL_ENV = (key = "URL", description = "Server URL (https://…)"): McpEnvSpec => ({
  key,
  description,
  required: true,
  placeholder: "https://",
});

const KEY_ENV = (key: string, description: string, placeholder?: string): McpEnvSpec => ({
  key,
  description,
  required: true,
  secret: true,
  placeholder,
});

/** Plain (non-secret) env value — stored and displayed as-is. */
const PLAIN_ENV = (key: string, description: string, placeholder?: string, required = false): McpEnvSpec => ({
  key,
  description,
  required,
  placeholder,
});

// ── The catalog ─────────────────────────────────────────────────────────────

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Databases & data planes ──
  entry("supabase", "Supabase", "Query tables, manage auth users, run edge functions, and manage your Postgres project.", "database",
    npx("@supabase/mcp-server-supabase", "--project-ref=<project-ref>"),
    [KEY_ENV("SUPABASE_ACCESS_TOKEN", "Personal access token (supabase.com/dashboard/account/tokens)")],
    { docsUrl: "https://supabase.com/docs/guides/getting-started/mcp", popular: true }),
  entry("firebase", "Firebase", "Manage Firestore documents, auth users, and Firebase project resources.", "database",
    npx("@gannonh/firebase-mcp"),
    [KEY_ENV("FIREBASE_SERVICE_ACCOUNT_KEY", "Service-account JSON (raw or base64)", "{…service account json…}")],
    { popular: true }),
  entry("postgres", "PostgreSQL (read-only)", "Inspect schemas and run read-only SQL against a Postgres database.", "database",
    npx("@modelcontextprotocol/server-postgres"), // reference server; successor: crystaldba/postgres-mcp
    [KEY_ENV("POSTGRES_CONNECTION_STRING", "postgres://user:pass@host:5432/db")],
    { popular: true }),
  entry("postgres-full", "PostgreSQL (full access)", "Read AND write Postgres: SQL execution, schema health, index tuning.", "database",
    uvx("postgres-mcp"),
    [KEY_ENV("DATABASE_URI", "postgresql://user:pass@host:5432/db")]),
  entry("neon", "Neon Postgres", "Manage Neon projects, branches, and run SQL on serverless Postgres.", "database",
    npx("@neondatabase/mcp-server-neon"),
    [KEY_ENV("NEON_API_KEY", "Neon API key")]),
  entry("mongodb", "MongoDB", "Query collections and inspect documents in a MongoDB deployment.", "database",
    npx("mongodb-mcp-server"),
    [KEY_ENV("MDB_MCP_CONNECTION_STRING", "mongodb+srv://user:pass@cluster/…")]),
  entry("redis", "Redis", "Inspect keys, streams, and run Redis commands.", "database",
    uvx("mcp-server-redis"),
    [KEY_ENV("REDIS_URI", "redis://host:6379")]),
  entry("sqlite", "SQLite", "Query and modify a local SQLite database file.", "database",
    uvx("mcp-server-sqlite", "--db-path", "database.db")),
  entry("mysql", "MySQL", "Schema inspection and read-only queries for MySQL.", "database",
    npx("@benborla29/mcp-server-mysql"),
    [KEY_ENV("MYSQL_HOST", "Host"), KEY_ENV("MYSQL_USER", "User"), KEY_ENV("MYSQL_PASS", "Password"), KEY_ENV("MYSQL_DATABASE", "Database name")]),
  entry("prisma", "Prisma Postgres", "Query and manage a Prisma Postgres instance.", "database",
    npx("prisma-mcp")),
  entry("clickhouse", "ClickHouse", "Run SQL and inspect tables on ClickHouse.", "database",
    uvx("mcp-clickhouse"),
    [KEY_ENV("CLICKHOUSE_HOST", "Host URL"), KEY_ENV("CLICKHOUSE_USER", "User"), KEY_ENV("CLICKHOUSE_PASSWORD", "Password", "••••")]),
  entry("duckdb", "DuckDB", "Query local files (Parquet/CSV/JSON) with DuckDB SQL.", "database",
    uvx("mcp-server-duckdb"), [], { popular: true }),
  entry("supabase-db-direct", "Supabase (direct DB)", "Talk to your Supabase Postgres over a direct connection string.", "database",
    uvx("postgres-mcp"),
    [KEY_ENV("DATABASE_URI", "postgresql://postgres:pass@db.<ref>.supabase.co:5432/postgres")]),
  entry("bigquery", "Google BigQuery", "Run SQL over BigQuery datasets with a service account.", "database",
    uvx("mcp-server-bigquery"),
    [KEY_ENV("BIGQUERY_PROJECT", "GCP project id"), KEY_ENV("GOOGLE_APPLICATION_CREDENTIALS_JSON", "Service-account JSON", "{…}")]),
  entry("snowflake", "Snowflake", "Query Snowflake warehouses and inspect schemas.", "database",
    uvx("mcp-snowflake-server"),
    [KEY_ENV("SNOWFLAKE_ACCOUNT", "Account identifier"), KEY_ENV("SNOWFLAKE_USER", "User"), KEY_ENV("SNOWFLAKE_PASSWORD", "Password", "••••"), KEY_ENV("SNOWFLAKE_WAREHOUSE", "Warehouse")]),

  // ── Cloud & hosting ──
  entry("vercel", "Vercel", "Manage deployments, projects, DNS, and logs on Vercel.", "cloud",
    npx("@vercel/mcp-adapter", "vercel"), // npx wrapper probes the official endpoint
    [KEY_ENV("VERCEL_API_TOKEN", "Token from vercel.com/account/tokens")],
    { docsUrl: "https://vercel.com/docs/mcp", popular: true }),
  entry("netlify", "Netlify", "Create sites, deploy builds, and read deploy logs.", "cloud",
    npx("netlify-mcp"),
    [KEY_ENV("NETLIFY_ACCESS_TOKEN", "Personal access token")]),
  entry("cloudflare", "Cloudflare", "Manage Workers, KV, R2, DNS, and analytics across your CF account.", "cloud",
    npx("@anthropic-ai/mcp-remote", "https://bindings.cloudflare.com/mcp"), // OAuth via remote endpoint
    [], { docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/" }),
  entry("aws", "AWS", "Query and operate AWS resources (S3, EC2, Lambda, CloudWatch…) with your credentials.", "cloud",
    uvx("awslabs.aws-api-mcp-server"),
    [KEY_ENV("AWS_ACCESS_KEY_ID", "Access key id"), KEY_ENV("AWS_SECRET_ACCESS_KEY", "Secret access key", "••••"), KEY_ENV("AWS_REGION", "Region", "us-east-1")]),
  entry("azure", "Azure", "Manage Azure resources, subscriptions, and deploy services.", "cloud",
    npx("@anthropic-ai/mcp-remote", "https://mcp.azure.com/mcp"), // Azure-hosted; OAuth on first use
    [], { docsUrl: "https://learn.microsoft.com/en-us/azure/developer/mcp/" }),
  entry("gcp", "Google Cloud", "Operate GCP: storage, bigquery, logging, cloud run.", "cloud",
    uvx("gcp-mcp"),
    [KEY_ENV("GCP_SERVICE_ACCOUNT_JSON", "Service-account JSON", "{…}")]),
  entry("s3", "AWS S3", "List buckets, upload/download objects, and copy files on S3.", "cloud",
    uvx("mcp-server-s3"),
    [KEY_ENV("AWS_ACCESS_KEY_ID", "Access key id"), KEY_ENV("AWS_SECRET_ACCESS_KEY", "Secret access key", "••••"), KEY_ENV("AWS_REGION", "Region", "us-east-1")]),
  entry("docker", "Docker", "Manage containers, images, volumes, and compose stacks locally.", "cloud",
    npx("@QuantGeekDev/docker-mcp")),
  entry("kubernetes", "Kubernetes", "Inspect pods, deployments, and logs in your kubectl-connected cluster.", "cloud",
    npx("mcp-server-kubernetes")),
  entry("railway", "Railway", "Deploy services and manage environments on Railway.", "cloud",
    npx("@anthropic-ai/mcp-remote", "https://railway.app/mcp")),
  entry("render", "Render", "List services, trigger deploys, and read logs on Render.", "cloud",
    npx("render-mcp"),
    [KEY_ENV("RENDER_API_KEY", "API key from dashboard → API keys")]),
  entry("flyio", "Fly.io", "Manage Fly machines and apps.", "cloud",
    npx("fly-mcp"),
    [KEY_ENV("FLY_API_TOKEN", "Fly.io token (flyctl tokens create)")]),

  // ── Dev tools & repos ──
  entry("github", "GitHub", "Repos, issues, PRs, actions, code search — act on GitHub from chat.", "devtools",
    npx("@modelcontextprotocol/server-github"),
    [KEY_ENV("GITHUB_PERSONAL_ACCESS_TOKEN", "PAT with repo scope", "ghp_…")],
    { popular: true }),
  entry("gitlab", "GitLab", "Manage GitLab projects, MRs, pipelines, and issues.", "devtools",
    npx("@zereight/mcp-gitlab"),
    [KEY_ENV("GITLAB_PERSONAL_ACCESS_TOKEN", "PAT"), KEY_ENV("GITLAB_API_URL", "API base", "https://gitlab.com/api/v4")]),
  entry("git", "Git (local)", "Read and operate on a local git repository: diff, log, commit, branch.", "devtools",
    uvx("mcp-server-git", "--repository", ".")),
  entry("bitbucket", "Bitbucket", "Manage Bitbucket repos and pull requests.", "devtools",
    uvx("mcp-server-bitbucket"),
    [KEY_ENV("BITBUCKET_USERNAME", "Username"), KEY_ENV("BITBUCKET_APP_PASSWORD", "App password", "••••")]),
  entry("sentry", "Sentry", "Triage errors and inspect stack traces from your Sentry project.", "devtools",
    npx("@sentry/mcp-server"),
    [KEY_ENV("SENTRY_TOKEN", "Auth token (OAuth prompt if empty)")], { popular: true }),
  entry("linear", "Linear", "Create and track issues, projects, and cycles.", "devtools",
    npx("linear-mcp-server"),
    [KEY_ENV("LINEAR_API_KEY", "API key (linear.app/settings/api)")], { popular: true }),
  entry("jira", "Jira", "Search and update Jira issues, sprints, and boards.", "devtools",
    npx("@anthropic-ai/mcp-remote", "https://mcp.atlassian.com/v1/mcp"), // Atlassian-hosted, OAuth
    [], { docsUrl: "https://support.atlassian.com/atlassian-cloud/docs/use-mcp-with-atlassian/", popular: true }),
  entry("grafana", "Grafana", "Query dashboards and datasources; investigate incidents.", "devtools",
    npx("mcp-grafana"),
    [KEY_ENV("GRAFANA_URL", "Grafana URL", "https://grafana.example.com"), KEY_ENV("GRAFANA_API_KEY", "Service account token")]),
  entry("prometheus", "Prometheus", "Run PromQL queries against your metrics.", "devtools",
    uvx("mcp-server-prometheus"),
    [KEY_ENV("PROMETHEUS_URL", "Prometheus URL")]),
  entry("sonarqube", "SonarQube", "Inspect code quality metrics and issues.", "devtools",
    npx("sonarqube-mcp-server"),
    [KEY_ENV("SONARQUBE_TOKEN", "SonarQube token")]),
  entry("circleci", "CircleCI", "Watch pipelines, rerun jobs, and download artifacts.", "devtools",
    npx("@circleci/mcp-server-circleci"),
    [KEY_ENV("CIRCLECI_TOKEN", "Personal API token")]),
  entry("datadog", "Datadog", "Query monitors, metrics, and logs from Datadog.", "devtools",
    npx("datadog-mcp-server"),
    [KEY_ENV("DD_API_KEY", "API key"), KEY_ENV("DD_APP_KEY", "Application key", "••••")]),
  entry("elasticsearch", "Elasticsearch", "Search indices and manage documents in ES.", "devtools",
    npx("@anthropic-ai/mcp-remote", "https://mcp.elastic.co/mcp")),
  entry("semgrep", "Semgrep", "Scan code for security vulnerabilities and anti-patterns.", "devtools",
    uvx("semgrep-mcp"), [], { popular: true }),
  entry("nx", "Nx console", "Understand and operate Nx workspaces: generators, tasks, graph.", "devtools",
    npx("nx-mcp")),
  entry("storybook", "Storybook", "Browse and test Storybook stories and components.", "devtools",
    npx("storybook-mcp")),
  entry("playwright", "Playwright (browser)", "Drive a real browser: navigate, click, screenshot, evaluate.", "devtools",
    npx("@playwright/mcp@latest"), [], { popular: true }),
  entry("puppeteer", "Puppeteer (browser)", "Headless Chrome automation and page scraping.", "devtools",
    npx("@modelcontextprotocol/server-puppeteer")),

  // ── Design ──
  entry("figma", "Figma", "Read designs, components, and dev-mode metadata from Figma files.", "design",
    npx("figma-developer-mcp", "--stdio"),
    [KEY_ENV("FIGMA_API_KEY", "Figma personal access token")],
    { popular: true }),
  entry("figma-remote", "Figma (official remote)", "Figma's hosted MCP endpoint with OAuth.", "design",
    npx("@anthropic-ai/mcp-remote", "https://mcp.figma.com/mcp"),
    [], { docsUrl: "https://mcp.figma.com" }),
  entry("blender", "Blender", "Create and manipulate 3D scenes in a running Blender instance.", "design",
    uvx("blender-mcp")),
  entry("canva", "Canva", "Create and edit Canva designs programmatically.", "design",
    npx("@anthropic-ai/mcp-remote", "https://mcp.canva.com/mcp")),
  entry("framer", "Framer", "Manage Framer projects and publish sites.", "design",
    npx("framer-mcp")),
  entry("penpot", "Penpot", "Interact with Penpot design files (open-source Figma alt).", "design",
    npx("penpot-mcp"),
    [KEY_ENV("PENPOT_API_TOKEN", "Penpot token")]),

  // ── Productivity & docs ──
  entry("notion", "Notion", "Search, read, and write Notion pages, databases, and blocks.", "productivity",
    npx("@notionhq/notion-mcp-server"),
    [KEY_ENV("NOTION_TOKEN", "Internal integration token (secret_…)")],
    { popular: true }),
  entry("slack", "Slack", "Read channels and send messages in your Slack workspace.", "productivity",
    npx("@anthropic-ai/mcp-remote", "https://mcp.slack.com/mcp"), // Slack-hosted, OAuth
    [], { popular: true }),
  entry("google-drive", "Google Drive", "Search and read files from Google Drive.", "productivity",
    npx("@modelcontextprotocol/server-gdrive"),
    [KEY_ENV("GOOGLE_CLIENT_ID", "OAuth client id"), KEY_ENV("GOOGLE_CLIENT_SECRET", "OAuth client secret", "••••")]),
  entry("google-calendar", "Google Calendar", "List events, create meetings, check availability.", "productivity",
    npx("google-calendar-mcp")),
  entry("google-maps", "Google Maps", "Geocoding, directions, and place lookups.", "productivity",
    npx("@modelcontextprotocol/server-google-maps"),
    [KEY_ENV("GOOGLE_MAPS_API_KEY", "Maps API key")]),
  entry("gmail", "Gmail", "Draft, search, and send email.", "productivity",
    npx("@anthropic-ai/mcp-remote", "https://gmail.mcp.google.com/mcp")),
  entry("confluence", "Confluence", "Search and edit Confluence spaces and pages.", "productivity",
    npx("confluence-mcp-server"),
    [KEY_ENV("CONFLUENCE_URL", "Site URL"), KEY_ENV("CONFLUENCE_EMAIL", "Email"), KEY_ENV("CONFLUENCE_API_TOKEN", "API token", "••••")]),
  entry("airtable", "Airtable", "Create, read, and update records in Airtable bases.", "productivity",
    npx("airtable-mcp-server"),
    [KEY_ENV("AIRTABLE_API_KEY", "Personal access token")], { popular: true }),
  entry("obsidian", "Obsidian", "Read and edit notes in your Obsidian vault (Local REST API plugin).", "productivity",
    npx("mcp-obsidian"),
    [KEY_ENV("OBSIDIAN_API_KEY", "REST API key from the plugin")]),
  entry("todoist", "Todoist", "Manage tasks and projects in Todoist.", "productivity",
    npx("@abhiz123/todoist-mcp-server"),
    [KEY_ENV("TODOIST_API_TOKEN", "API token")]),
  entry("asana", "Asana", "Manage Asana tasks, projects, and teams.", "productivity",
    npx("asana-mcp-server"),
    [KEY_ENV("ASANA_ACCESS_TOKEN", "Personal access token")]),
  entry("trello", "Trello", "Read and manage Trello boards, lists, and cards.", "productivity",
    uvx("mcp-server-trello"),
    [KEY_ENV("TRELLO_API_KEY", "API key"), KEY_ENV("TRELLO_TOKEN", "Token")]),
  entry("markdown-notes", "Markdown notes (filesystem)", "Give the agent structured access to a folder of markdown notes.", "productivity",
    npx("@modelcontextprotocol/server-filesystem", "/path/to/notes")),

  // ── Data, scraping & fetching ──
  entry("fetch", "Fetch (web pages)", "Fetch a URL and return clean readable text/markdown.", "web",
    uvx("mcp-server-fetch"), [], { popular: true }),
  entry("firecrawl", "Firecrawl", "Scrape, crawl, and extract structured data from websites.", "data",
    npx("firecrawl-mcp"),
    [KEY_ENV("FIRECRAWL_API_KEY", "API key (firecrawl.dev)")], { popular: true }),
  entry("browserbase", "Browserbase", "Run headless browser sessions in the cloud for scraping.", "data",
    npx("@browserbasehq/mcp-server-browserbase"),
    [KEY_ENV("BROWSERBASE_API_KEY", "API key"), KEY_ENV("BROWSERBASE_PROJECT_ID", "Project id")]),
  entry("apify", "Apify", "Run Apify actors (web scrapers) and fetch their results.", "data",
    npx("apify-mcp-server"),
    [KEY_ENV("APIFY_TOKEN", "Apify token")]),
  entry("tavily", "Tavily", "AI-optimized web search API with clean results.", "search",
    npx("tavily-mcp"),
    [KEY_ENV("TAVILY_API_KEY", "API key (tavily.com)")], { popular: true }),
  entry("brave-search", "Brave Search", "Web and local search via the Brave Search API.", "search",
    npx("@modelcontextprotocol/server-brave-search"),
    [KEY_ENV("BRAVE_API_KEY", "API key")], { popular: true }),
  entry("exa", "Exa", "Neural/semantic web search and similar-page search.", "search",
    npx("exa-mcp-server"),
    [KEY_ENV("EXA_API_KEY", "API key (exa.ai)")]),
  entry("perplexity", "Perplexity", "Ask Perplexity's models for cited web answers.", "search",
    npx("perplexity-ask"),
    [KEY_ENV("PERPLEXITY_API_KEY", "API key (pplx-…)")]),
  entry("duckduckgo", "DuckDuckGo", "Free web search with no API key required.", "search",
    uvx("duckduckgo-mcp-server"), [], { popular: true }),
  entry("youtube", "YouTube", "Search videos, fetch transcripts, and manage a channel.", "data",
    uvx("youtube-mcp"),
    [KEY_ENV("YOUTUBE_API_KEY", "YouTube Data API v3 key")]),
  entry("wikipedia", "Wikipedia", "Search and read encyclopedia articles.", "data",
    npx("@anthropic-ai/mcp-remote", "https://mcp.wikipedia.org/mcp")),
  entry("context7", "Context7 (library docs)", "Up-to-date documentation for thousands of libraries, injected at prompt time.", "search",
    npx("@upstash/context7-mcp"), [], { popular: true }),
  entry("deepwiki", "DeepWiki (repo docs)", "Ask questions about any public GitHub repo and get cited answers.", "search",
    npx("@anthropic-ai/mcp-remote", "https://mcp.deepwiki.com/mcp")),
  entry("arxiv", "arXiv", "Search and fetch research papers.", "data",
    uvx("arxiv-mcp-server")),
  entry("reddit", "Reddit", "Read posts and comments from subreddits.", "data",
    uvx("mcp-server-reddit")),
  entry("stripe", "Stripe", "Manage customers, payments, and subscriptions (test-mode safe options).", "payments",
    npx("@stripe/mcp"),
    [KEY_ENV("STRIPE_SECRET_KEY", "Secret key", "sk_…")], { popular: true }),
  entry("paypal", "PayPal", "Create and inspect invoices and payments.", "payments",
    npx("@anthropic-ai/mcp-remote", "https://mcp.paypal.com/mcp")),
  entry("razorpay", "Razorpay", "Manage Razorpay payments and refunds.", "payments",
    npx("razorpay-mcp-server"),
    [KEY_ENV("RAZORPAY_KEY_ID", "Key id"), KEY_ENV("RAZORPAY_KEY_SECRET", "Key secret", "••••")]),
  entry("shopify", "Shopify (dev docs)", "GraphQL schema exploration and dev docs for Shopify apps.", "payments",
    npx("@shopify/dev-mcp")),

  // ── AI & agents ──
  entry("openai", "OpenAI", "Call OpenAI models and APIs as a tool from the agent.", "ai",
    npx("mcp-openai"),
    [KEY_ENV("OPENAI_API_KEY", "API key", "sk-…")]),
  entry("anthropic", "Anthropic", "Call Claude models and APIs as a tool.", "ai",
    npx("mcp-anthropic"),
    [KEY_ENV("ANTHROPIC_API_KEY", "API key", "sk-ant-…")]),
  entry("huggingface", "Hugging Face", "Search models/datasets/spaces and run HF inference.", "ai",
    npx("@anthropic-ai/mcp-remote", "https://huggingface.co/mcp")),
  entry("elevenlabs", "ElevenLabs", "Text-to-speech and voice cloning.", "ai",
    npx("@anthropic-ai/mcp-remote", "https://mcp.elevenlabs.io/mcp"),
    [KEY_ENV("ELEVENLABS_API_KEY", "API key")]),
  entry("memory", "Persistent memory", "Knowledge-graph memory the agent can read/write across runs.", "ai",
    npx("@modelcontextprotocol/server-memory"), [], { popular: true }),
  entry("sequential-thinking", "Sequential thinking", "Structured step-by-step reasoning scaffold for hard problems.", "ai",
    npx("@modelcontextprotocol/server-sequential-thinking"), [], { popular: true }),
  entry("everything", "Everything (test server)", "Reference MCP server exercising every protocol capability — useful to verify the pipeline.", "ai",
    npx("@modelcontextprotocol/server-everything")),

  // ── Communication ──
  entry("telegram", "Telegram", "Send messages and manage a Telegram bot.", "comms",
    uvx("telegram-mcp"),
    [KEY_ENV("TELEGRAM_BOT_TOKEN", "Bot token from BotFather")]),
  entry("discord", "Discord", "Read channels and send messages to a Discord server.", "comms",
    npx("discord-mcp"),
    [KEY_ENV("DISCORD_BOT_TOKEN", "Bot token"), KEY_ENV("DISCORD_GUILD_ID", "Server id")]),
  entry("twilio", "Twilio", "Send SMS/WhatsApp and manage calls.", "comms",
    npx("@twilio-alpha/mcp"),
    [KEY_ENV("TWILIO_ACCOUNT_SID", "Account SID"), KEY_ENV("TWILIO_AUTH_TOKEN", "Auth token", "••••")]),
  entry("whatsapp", "WhatsApp", "Send WhatsApp messages via the Business Cloud API.", "comms",
    npx("whatsapp-mcp-server"),
    [KEY_ENV("WHATSAPP_ACCESS_TOKEN", "Access token"), KEY_ENV("WHATSAPP_PHONE_NUMBER_ID", "Phone number id")]),

  // ── Files & shell ──
  entry("filesystem", "Filesystem (sandboxed folder)", "Read/write files inside a folder you choose.", "files",
    npx("@modelcontextprotocol/server-filesystem", "/absolute/path/to/folder"), [], { popular: true }),
  entry("google-sheets", "Google Sheets", "Read and write spreadsheets.", "files",
    npx("google-sheets-mcp"),
    [KEY_ENV("GOOGLE_SHEETS_CREDENTIALS", "Service-account JSON", "{…}")]),
  entry("dropbox", "Dropbox", "Browse and fetch files from Dropbox.", "files",
    npx("dropbox-mcp-server"),
    [KEY_ENV("DROPBOX_ACCESS_TOKEN", "OAuth token")]),
  entry("excel", "Excel / spreadsheets", "Read and write Excel workbooks and CSV data.", "files",
    npx("excel-mcp-server")),
  entry("one-drive", "OneDrive / SharePoint", "Search and read files from Microsoft 365.", "files",
    npx("@anthropic-ai/mcp-remote", "https://mcp.microsoft365.com/mcp")),
  entry("shell", "Shell (sandboxed)", "Run allow-listed shell commands as tools.", "shell",
    npx("mcp-shell"),
    [PLAIN_ENV("SHELL_ALLOWLIST", "Comma-separated commands", "ls,grep,wc")]),
  entry("terminal-control", "Terminal", "Persistent terminal sessions the agent can drive.", "shell",
    npx("@wonderwhy-er/desktop-commander")),
];

/** All categories in display order with labels. */
export const MCP_CATEGORIES: Array<{ key: McpCategory | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "database", label: "Databases" },
  { key: "devtools", label: "Dev tools" },
  { key: "cloud", label: "Cloud" },
  { key: "design", label: "Design" },
  { key: "productivity", label: "Productivity" },
  { key: "data", label: "Data" },
  { key: "search", label: "Search" },
  { key: "ai", label: "AI" },
  { key: "payments", label: "Payments" },
  { key: "comms", label: "Comms" },
  { key: "files", label: "Files" },
  { key: "shell", label: "Shell" },
  { key: "web", label: "Web" },
];

export function getMcpCatalogEntry(id: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((e) => e.id === id) ?? null;
}

/**
 * Search the catalog: name/id/description match, optional category filter.
 * Name and id hits rank above description hits; popular entries rank above
 * the rest inside a tie. Pure function — unit-tested.
 */
export function searchMcpCatalog(
  query: string,
  category: McpCategory | "all" = "all",
  limit = 60
): McpCatalogEntry[] {
  // Normalize hyphens/underscores to spaces on both sides so "knowledge
  // graph" finds "Knowledge-graph" and "brave_search" finds "brave search".
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, " ");
  const q = norm(query.trim());
  const pool = category === "all" ? MCP_CATALOG : MCP_CATALOG.filter((e) => e.category === category);
  const score = (e: McpCatalogEntry): number => {
    if (!q) return e.popular ? 2 : 1;
    const name = norm(e.name);
    const id = norm(e.id);
    if (name === q || id === q) return 100;
    if (name.startsWith(q) || id.startsWith(q)) return 80;
    if (name.includes(q) || id.includes(q)) return 60;
    if (norm(e.description).includes(q)) return 40;
    if (e.category.includes(q)) return 20;
    return 0;
  };
  return pool
    .map((e) => ({ e, s: score(e) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || (a.e.popular ? -1 : 1))
    .slice(0, limit)
    .map(({ e }) => e);
}

/** Count for UI ("100+ servers"). */
export const MCP_CATALOG_SIZE = MCP_CATALOG.length;

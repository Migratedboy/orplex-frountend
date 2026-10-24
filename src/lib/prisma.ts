// @ts-ignore - PrismaClient type not resolving with bundler moduleResolution
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// Supabase uses PgBouncer for connection pooling.
// When using the transactional pooler (port 6543), we need:
//   ?pgbouncer=true&connection_limit=1&pool_timeout=20
// When using the session pooler (port 5432), default settings work.
//
// For production, use the transactional pooler URL from Supabase dashboard:
//   Settings > Database > Connection string > Transaction mode
//
// Example URL:
//   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true

function buildPrismaClient() {
  const DATABASE_URL = process.env.DATABASE_URL;

  // Fail fast: a localhost DB URL can never work on a cloud host — it means
  // laptop dev values leaked into production env (Vercel dashboard). Crash
  // the boot loudly instead of serving 500s on every DB call.
  // Scoped to Vercel: the Electron shell spawns its own local API with
  // NODE_ENV=production too, and the database may legitimately live behind
  // whatever ORPLEX_API_URL points at, so this must never fire locally.
  // Skipped during `next build` (NEXT_PHASE): static collection evaluates
  // modules with build-time env; the running server enforces on boot.
  if (
    process.env.VERCEL &&
    process.env.NODE_ENV === "production" &&
    !String(process.env.NEXT_PHASE || "").includes("build") &&
    DATABASE_URL &&
    /localhost|127\.0\.0\.1/.test(DATABASE_URL)
  ) {
    throw new Error(
      "[prisma] DATABASE_URL points at localhost in production — set the Supabase pooler URL (Transaction mode, port 6543) in the host dashboard."
    );
  }

  // If using Supabase transactional pooler, append connection pool params
  // if they're not already in the URL
  if (DATABASE_URL && DATABASE_URL.includes("pooler.supabase.com") && !DATABASE_URL.includes("pgbouncer")) {
    const separator = DATABASE_URL.includes("?") ? "&" : "?";
    process.env.DATABASE_URL = `${DATABASE_URL}${separator}pgbouncer=true&connection_limit=1&pool_timeout=20`;
  }

  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

// Reuse one client per process (HMR / repeated module evaluation must not
// open a second pool), and remember whether WE were the first evaluator so
// the shutdown handlers below are registered exactly once.
const hadClient = !!globalForPrisma.prisma;
export const prisma = globalForPrisma.prisma || buildPrismaClient();

if (!hadClient) globalForPrisma.prisma = prisma;

// Graceful shutdown handler (Node.js pattern 11)
// Clean up database connections on process termination
const gracefulShutdown = async (signal: string) => {
  console.log(`[Prisma] Received ${signal}, closing database connections...`);
  await prisma.$disconnect();
  console.log("[Prisma] Database connections closed.");
  process.exit(0);
};

// Register shutdown handlers only once PER PROCESS. The old guard read
// `globalForPrisma.prisma` AFTER the assignment above, so it was never true
// in dev — Ctrl+C never disconnected cleanly — and always true in prod.
// Jest workers must not register: a signal listener keeps the worker's event
// loop alive and reintroduces the leaked-handle hangs `forceExit` papers over.
const shutdownFlag = globalThis as unknown as { __orplexPrismaShutdown?: boolean };
if (!shutdownFlag.__orplexPrismaShutdown && process.env.JEST_WORKER_ID === undefined) {
  shutdownFlag.__orplexPrismaShutdown = true;
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

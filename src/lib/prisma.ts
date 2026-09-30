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

export const prisma = globalForPrisma.prisma || buildPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Graceful shutdown handler (Node.js pattern 11)
// Clean up database connections on process termination
const gracefulShutdown = async (signal: string) => {
  console.log(`[Prisma] Received ${signal}, closing database connections...`);
  await prisma.$disconnect();
  console.log("[Prisma] Database connections closed.");
  process.exit(0);
};

// Register shutdown handlers only once
if (!globalForPrisma.prisma) {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

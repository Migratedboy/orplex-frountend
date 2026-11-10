// prisma.ts — THE persistence seam. HYBRID, one owner per model (no doubling):
// CLOUD owns identity + playbook (user/account/session/verificationToken/
// learning); LOCAL owns everything else (conversations, messages, keys, runs,
// events, quota, MCP, telemetry) and holds only an offline FALLBACK for the
// cloud models, pruned automatically when the cloud is healthy.
//
// USER DECISION (2026-11-06): users' email + login/signup info and the
// playbook (Learning) persist in the CLOUD database; EVERYTHING ELSE —
// conversations, messages, keys, runs, events, quota, MCP, telemetry — lives
// in device-local JSON files (.orplex/db/<model>.json via local-db.ts) with
// no database server required at all.
//
// Behavior:
// - `user` / `account` / `session` / `verificationToken` / `learning` → the
//   real PrismaClient against DATABASE_URL whenever it is configured. If the
//   cloud is missing or a query fails, the SAME call falls back to the local
//   JSON engine — so a dead cloud can never brick sign-in or the app.
// - all other models → local engine, always. (.orplex/db/<model>.json, atomic
//   tmp+rename writes, capped telemetry collections.)
// - The returned object is typed as PrismaClient, so ~130 call sites keep
//   their exact prisma call shapes (payload types, include, P2002 races).

import { PrismaClient } from "@prisma/client";
import { buildLocalDbClient, pruneCloudDuplicates, CLOUD_OWNED_MODELS, type LocalDbClient, LocalDbError } from "./local-db";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Models that MUST live in the cloud (identity + playbook). Single source of
 *  truth in local-db.ts (CLOUD_OWNED_MODELS) so the two seams can't drift. */
const CLOUD_MODELS = CLOUD_OWNED_MODELS;

function buildCloudClient(): PrismaClient | null {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL || !DATABASE_URL.trim()) return null;

  // Fail fast: a localhost DB URL can never work on a cloud host — it means
  // laptop dev values leaked into production env (Vercel dashboard). Scoped
  // to Vercel only; the desktop legitimately uses DATABASE_URL itself.
  // Skipped during `next build` (NEXT_PHASE).
  if (
    process.env.VERCEL &&
    process.env.NODE_ENV === "production" &&
    !String(process.env.NEXT_PHASE || "").includes("build") &&
    /localhost|127\.0\.0\.1/.test(DATABASE_URL)
  ) {
    throw new Error(
      "[prisma] DATABASE_URL points at localhost in production — set the Neon pooled DATABASE_URL in the host dashboard."
    );
  }

  // Pooled hosts (Neon *-pooler.*) need pooler params; direct hosts don't.
  if (/pooler/i.test(DATABASE_URL)) {
    try {
      const url = new URL(DATABASE_URL);
      url.searchParams.set("pgbouncer", "true");
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("pool_timeout", "20");
      process.env.DATABASE_URL = url.toString();
    } catch {
      // Unparseable URL — leave it untouched (the client will report it).
    }
  }

  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

/**
 * Cloud-delegate wrapper: cloud answers first; on ANY failure (missing URL,
 * unreachable DB, 401) the identical call replays against the LOCAL engine so
 * identity + playbook stay functional offline. Returns history so bad states
 * are diagnosable but never thrown at call sites.
 * `getCloudModel` resolves the cloud's model delegate lazily (the cloud
 * PrismaClient is only constructed on the first identity/playbook touch).
 */
function cloudFirstDelegate(modelName: string, getCloudModel: () => unknown, localDelegate: unknown): unknown {
  return new Proxy(
    {},
    {
      get(_t, method: string | symbol) {
        if (typeof method !== "string") return undefined;
        const localFn = (localDelegate as Record<string, (args: unknown) => PromiseLike<unknown>>)[method];
        if (typeof localFn !== "function") return undefined;
        const cloudModel = getCloudModel();
        const cloudFn = (cloudModel as Record<string, (args: unknown) => PromiseLike<unknown>> | null)?.[method];
        if (typeof cloudFn !== "function") return (...args: unknown[]) => localFn(args[0]);
        const warn = (e: unknown) =>
          console.warn("[prisma-hybrid]", `cloud ${modelName}.${method} failed → local fallback:`, String((e as Error)?.message).slice(0, 140));
        return (...args: unknown[]) => {
          const run = async () => {
            try {
              return await cloudFn(args[0]);
            } catch (e) {
              warn(e);
              return localFn(args[0]);
            }
          };
          return {
            then: (onF: (v: unknown) => unknown, onRej: (e: unknown) => unknown) => Promise.resolve(run()).then(onF, onRej),
            catch: (onRej: (e: unknown) => unknown) => Promise.resolve(run()).catch(onRej),
            finally: async (cb: () => void) => {
              try {
                await Promise.resolve(run());
              } finally {
                cb();
              }
            },
          };
        };
      },
    }
  );
}

function buildHybridClient(): PrismaClient {
  const local = buildLocalDbClient();
  let cloud: PrismaClient | null = null;
  let cloudBuildFailed = false;
  let pruned = false;
  const cloudOnce = (): PrismaClient | null => {
    if (cloud || cloudBuildFailed) return cloud;
    try {
      cloud = buildCloudClient();
      cloudBuildFailed = cloud === null;
      // Cloud is up: prune local duplicates so local never doubles the
      // cloud for identity + playbook. Once per process, fire-and-forget.
      if (cloud && !pruned) {
        pruned = true;
        void pruneCloudDuplicates(
          cloud as unknown as Record<string, { findMany: (a: unknown) => Promise<{ id: string }[]> } | undefined>,
          local
        ).then((report) => {
          const total = Object.values(report).reduce((a, b) => a + b, 0);
          if (total > 0) console.log("[prisma-hybrid] pruned", total, "local duplicate(s)", report);
        });
      }
    } catch (e) {
      cloudBuildFailed = true;
      console.warn("[prisma-hybrid] cloud client unavailable → identity models run LOCAL:", String((e as Error)?.message).slice(0, 140));
    }
    return cloud;
  };

  const proxy = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== "string") return undefined;
        if (CLOUD_MODELS.has(prop)) {
          // Cloud-first with local fallback for every method. The cloud
          // delegate resolves lazily so `prisma` itself stays cheap.
          const cloudModelName = prop;
          return cloudFirstDelegate(
            cloudModelName,
            () => cloudOnce()?.[cloudModelName as keyof PrismaClient] ?? null,
            (local as unknown as Record<string, unknown>)[prop]
          );
        }
        return (local as unknown as Record<string, unknown>)[prop];
      },
    }
  ) as unknown as PrismaClient;
  return proxy;
}

export const prisma = globalForPrisma.prisma ?? (globalForPrisma.prisma = buildHybridClient());

// --- exports used elsewhere (do not change call sites) ---
export { LocalDbError };

// NOTE: no process shutdown handlers registered (the old `$disconnect` on
// SIGTERM): the local engine has no sockets and writes atomically per op; the
// cloud client closes via the runtime's own teardown.

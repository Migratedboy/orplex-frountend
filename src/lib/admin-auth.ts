import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "./auth";

const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * With ADMIN_USER_IDS set, only those ids are admin. With it unset we used to
 * hand EVERY signed-in user the admin surface — harmless locally, a hole the
 * moment NODE_ENV=production. So: open in dev, fail closed in production
 * (loudly, so it reads as misconfiguration rather than an outage).
 */
function adminsAllowedWhenUnset(): boolean {
  if (ADMIN_IDS.length > 0 || process.env.NODE_ENV !== "production") return true;
  console.error(
    "[admin] ADMIN_USER_IDS is unset in production — denying all admin access. " +
      "Set ADMIN_USER_IDS to a comma-separated list of user ids to restore it.",
  );
  return false;
}

export async function requireAdmin() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    // Exact strings: every /api/admin route maps Unauthorized→401,
    // Forbidden→403, anything else→500.
    throw new Error("Unauthorized");
  }
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(session.user.id)) {
    throw new Error("Forbidden");
  }
  if (!adminsAllowedWhenUnset()) {
    throw new Error("Forbidden");
  }
  return session.user;
}

export function isAdmin(userId: string): boolean {
  if (ADMIN_IDS.length === 0) return adminsAllowedWhenUnset();
  return ADMIN_IDS.includes(userId);
}

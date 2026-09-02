import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "./auth";

const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

export async function requireAdmin() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(session.user.id)) {
    throw new Error("Forbidden");
  }
  return session.user;
}

export function isAdmin(userId: string): boolean {
  if (ADMIN_IDS.length === 0) return true; // No admin restriction in dev
  return ADMIN_IDS.includes(userId);
}

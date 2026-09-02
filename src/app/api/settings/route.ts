import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UnauthorizedError, ValidationError, handleError, successResponse } from "@/lib/errors";
import { logRequest, logError } from "@/lib/logger";

export async function GET() {
  const start = Date.now();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, image: true },
    });

    logRequest("GET", "/api/settings", start, 200);
    return successResponse(user);
  } catch (error) {
    logError(error, { route: "settings", method: "GET" });
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const start = Date.now();
  try {
    // Rule 1.5: Parallelize independent async operations
    const [session, body] = await Promise.all([
      getServerSession(authOptions),
      request.json(),
    ]);

    if (!session?.user?.id) throw new UnauthorizedError();

    // Validate input
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        throw new ValidationError("Name must be a string", [{ field: "name", message: "Must be a string" }]);
      }
      if (body.name.trim().length < 1) {
        throw new ValidationError("Name is required", [{ field: "name", message: "Cannot be empty" }]);
      }
      if (body.name.length > 100) {
        throw new ValidationError("Name too long", [{ field: "name", message: "Must be under 100 characters" }]);
      }
    }

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { name: body.name?.trim() },
      select: { id: true, name: true, email: true },
    });

    logRequest("PATCH", "/api/settings", start, 200);
    return successResponse(user);
  } catch (error) {
    logError(error, { route: "settings", method: "PATCH" });
    return handleError(error);
  }
}
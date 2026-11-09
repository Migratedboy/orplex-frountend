import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { UnauthorizedError, ValidationError, handleError, successResponse } from "@/lib/errors";
import { logRequest, logError } from "@/lib/logger";
import {
  memoryList,
  memoryRead,
  memoryWrite,
  memoryStrReplace,
  memoryAppend,
  memoryDelete,
  memorySettingGet,
  memorySettingSet,
} from "@/lib/memory-store";

export async function GET(request: NextRequest) {
  const start = Date.now();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();

    const { searchParams } = new URL(request.url);
    const op = searchParams.get("op") || "list";
    const prefix = searchParams.get("prefix") || undefined;

    if (op === "list") {
      const files = await memoryList(session.user.id, prefix);
      const setting = await memorySettingGet(session.user.id);
      logRequest("GET", "/api/memory", start, 200);
      return successResponse({ files, setting });
    }
    if (op === "read") {
      const pathsParam = searchParams.get("paths") || searchParams.get("path") || "";
      const paths = pathsParam.includes(",") ? pathsParam.split(",").map((s) => s.trim()).filter(Boolean) : [pathsParam].filter(Boolean);
      if (paths.length === 0) throw new ValidationError("path required", [{ field: "path", message: "required" }]);
      const files = await memoryRead(paths, session.user.id);
      logRequest("GET", "/api/memory", start, 200);
      return successResponse({ files });
    }
    if (op === "setting") {
      const setting = await memorySettingGet(session.user.id);
      logRequest("GET", "/api/memory", start, 200);
      return successResponse({ setting });
    }
    throw new ValidationError("unknown op", [{ field: "op", message: "list|read|setting" }]);
  } catch (error) {
    logError(error, { route: "memory", method: "GET" });
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const start = Date.now();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();
    const body = await request.json();
    const op = body?.op || "write";

    if (op === "write") {
      const { path, content, if_version } = body;
      if (!path || typeof content !== "string") throw new ValidationError("path+content required", [{ field: "path", message: "required" }]);
      const r = await memoryWrite(path, content, if_version ?? "new", session.user.id);
      logRequest("POST", "/api/memory", start, 200);
      return successResponse(r);
    }
    if (op === "str_replace") {
      const { path, old_str, new_str, if_version } = body;
      const r = await memoryStrReplace(path, old_str, new_str, if_version ?? "new", session.user.id);
      logRequest("POST", "/api/memory", start, 200);
      return successResponse(r);
    }
    if (op === "append") {
      const { path, content, if_version } = body;
      const r = await memoryAppend(path, content, if_version ?? "new", session.user.id);
      logRequest("POST", "/api/memory", start, 200);
      return successResponse(r);
    }
    if (op === "delete") {
      const { path, if_version } = body;
      const r = await memoryDelete(path, if_version ?? "new", session.user.id);
      logRequest("POST", "/api/memory", start, 200);
      return successResponse(r);
    }
    if (op === "setting") {
      const { enabled, incognito } = body;
      await memorySettingSet(session.user.id, { enabled, incognito });
      const setting = await memorySettingGet(session.user.id);
      logRequest("POST", "/api/memory", start, 200);
      return successResponse({ setting });
    }
    throw new ValidationError("unknown op", [{ field: "op", message: "write|str_replace|append|delete|setting" }]);
  } catch (error) {
    logError(error, { route: "memory", method: "POST" });
    return handleError(error);
  }
}

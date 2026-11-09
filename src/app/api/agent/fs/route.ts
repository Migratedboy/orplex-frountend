// fs — Files-tab local disk reads/writes (Right Panel v2, P3; DECISIONS D7).
//
// GET ?dir=<rel>    list one directory (lazy tree). Hidden: .git, node_modules,
//                   .next — other dotfiles (.github, .orplex, …) are shown.
// POST {op,...}     create | mkdir | rename | delete — all workspace-jailed,
//                   recorded via workspace-history (F9) where the change has
//                   content to snapshot.
//
// Deletes move to `<workspace>/.orplex/trash/` (browser parity); the desktop
// app can prefer the Recycle Bin via electron `fs-ops:trash`. Everything here
// is LOCAL_ONLY: the disk it touches is the user's own.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { readdir, stat, writeFile, mkdir, rename, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import { safeJoinWorkspace, appendHistory } from "@/lib/workspace-history";
import { validateEntryName, normalizeRelPath, MAX_PATH_LENGTH } from "@/lib/fs-ops-validate";
import { publicErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

const HIDDEN_DIRS = new Set([".git", "node_modules", ".next"]);
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

function err(status: number, message: string) {
  return NextResponse.json({ success: false, error: message }, { status });
}

/** Resolve a workspace-relative path with every gate applied. */
function jail(root: string, rel: unknown): { abs: string; rel: string } | null {
  if (typeof rel !== "string") return null;
  const norm = normalizeRelPath(rel);
  if (!norm) return null;
  const abs = safeJoinWorkspace(root, norm);
  if (!abs || abs.length > MAX_PATH_LENGTH) return null;
  if (!root || !resolve(abs).startsWith(resolve(root))) return null;
  return { abs, rel: norm };
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return err(401, "Authentication required");
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return err(400, "no workspace");

  try {
    // Raw file bytes (image viewer): GET ?file=<rel> → the file itself.
    const fileParam = request.nextUrl.searchParams.get("file");
    if (fileParam) {
      const target = jail(root, fileParam);
      if (!target) return err(403, "path escapes workspace");
      const st = await stat(target.abs).catch(() => null);
      if (!st?.isFile()) return err(404, "file not found");
      if (st.size > 25 * 1024 * 1024) return err(413, "file too large to preview");
      const buf = await readFile(target.abs);
      const ext = target.abs.split(".").pop()?.toLowerCase() ?? "";
      const mime: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
        bmp: "image/bmp", avif: "image/avif",
      };
      return new NextResponse(buf, {
        headers: {
          "Content-Type": mime[ext] ?? "application/octet-stream",
          "Content-Disposition": `inline; filename="${encodeURIComponent(basename(target.abs))}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const dirParam = request.nextUrl.searchParams.get("dir");
    let absDir = root;
    let relDir = "";
    if (dirParam) {
      const jailed = jail(root, dirParam);
      if (!jailed) return err(403, "path escapes workspace");
      absDir = jailed.abs;
      relDir = jailed.rel;
    }
    const dirStat = await stat(absDir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) return err(404, "folder not found");

    const dentries = await readdir(absDir, { withFileTypes: true });
    const entries: Array<{ name: string; kind: "file" | "directory"; size?: number }> = [];
    for (const d of dentries) {
      if (HIDDEN_DIRS.has(d.name)) continue;
      if (d.isDirectory()) {
        entries.push({ name: d.name, kind: "directory" });
      } else if (d.isFile()) {
        const st = await stat(join(absDir, d.name)).catch(() => null);
        entries.push({ name: d.name, kind: "file", size: st?.size ?? 0 });
      }
    }
    entries.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : a.name.localeCompare(b.name)
    );
    return NextResponse.json({ success: true, dir: relDir, entries });
  } catch (e) {
    return err(500, publicErrorMessage(e, "List failed"));
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return err(401, "Authentication required");
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return err(400, "no workspace");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.op !== "string") return err(400, "invalid fs request");

  try {
    switch (body.op) {
      case "create": {
        const target = jail(root, body.path);
        if (!target) return err(403, "invalid path");
        const content = typeof body.content === "string" ? body.content : "";
        const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
        if (content.length > MAX_CONTENT_BYTES) return err(413, "file too large (10 MB cap)");
        const parentStat = await stat(join(target.abs, "..")).catch(() => null);
        if (!parentStat?.isDirectory()) return err(404, "parent folder does not exist");
        if (await stat(target.abs).catch(() => null)) return err(409, "a file or folder with this name already exists");
        if (contentBase64) {
          const buf = Buffer.from(contentBase64, "base64");
          await writeFile(target.abs, buf);
          await appendHistory(root, { path: target.rel, prev: null, next: buf.toString("base64"), encoding: "base64" }).catch(() => false);
        } else {
          await writeFile(target.abs, content, "utf8");
          await appendHistory(root, { path: target.rel, prev: null, next: content }).catch(() => false);
        }
        return NextResponse.json({ success: true, path: target.rel });
      }

      case "mkdir": {
        const target = jail(root, body.path);
        if (!target) return err(403, "invalid path");
        if (await stat(target.abs).catch(() => null)) return err(409, "a file or folder with this name already exists");
        await mkdir(target.abs);
        return NextResponse.json({ success: true, path: target.rel });
      }

      case "rename": {
        const from = jail(root, body.from);
        const to = jail(root, body.to);
        if (!from || !to) return err(403, "invalid path");
        const nameCheck = validateEntryName(basename(to.rel));
        if (!nameCheck.ok) return err(400, nameCheck.reason ?? "invalid name");
        const fromStat = await stat(from.abs).catch(() => null);
        if (!fromStat) return err(404, "source not found");
        if (await stat(to.abs).catch(() => null)) return err(409, "destination already exists");
        if (to.abs.startsWith(from.abs + "/") || to.abs.startsWith(from.abs + "\\")) {
          return err(400, "cannot move a folder into itself");
        }
        await rename(from.abs, to.abs);
        // Rename changes the path, not content — git shows it; durable
        // history records no fabricated snapshot (see D7/D8).
        return NextResponse.json({ success: true, from: from.rel, to: to.rel });
      }

      case "delete": {
        const target = jail(root, body.path);
        if (!target) return err(403, "invalid path");
        const st = await stat(target.abs).catch(() => null);
        if (!st) return err(404, "not found");
        // Snapshot content for undo where feasible (10 MB text cap).
        let prev: string | null = null;
        if (st.isFile() && st.size <= MAX_CONTENT_BYTES) {
          prev = await readFile(target.abs, "utf8").catch(() => null);
        }
        const trashDir = join(root, ".orplex", "trash");
        await mkdir(trashDir, { recursive: true }).catch(() => {});
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const trashPath = join(trashDir, `${stamp}-${basename(target.rel)}`);
        await rename(target.abs, trashPath);
        if (prev !== null) {
          await appendHistory(root, { path: target.rel, prev, next: null }).catch(() => false);
        }
        return NextResponse.json({ success: true, path: target.rel, trashPath: trashPath.slice(root.length + 1) });
      }

      default:
        return err(400, `unknown op: ${body.op}`);
    }
  } catch (e) {
    return err(500, publicErrorMessage(e, "File operation failed"));
  }
}

// Where a project lives on disk (server-only).
//
// The name rules themselves are pure and live in project-names.ts, because the
// modal (a client component) validates as you type. This half adds the parts
// that need the filesystem: the default projects directory, the "is this parent
// real" check, the path jail, and actually making the folder.

import { homedir } from "os";
import { join, resolve, sep, isAbsolute, basename } from "path";
import { stat, mkdir } from "fs/promises";
import { projectNameMessage, projectNameProblem } from "@/lib/project-names";

export { MAX_PROJECT_NAME, projectNameMessage, projectNameProblem } from "@/lib/project-names";
export type { NameProblem } from "@/lib/project-names";

/**
 * Default home for new projects. Deliberately NOT process.cwd(): that is the
 * installed app's own directory, and writing user projects into it means a
 * reinstall silently takes them with it.
 */
export function defaultProjectsDir(): string {
  const override = (process.env.ORPLEX_PROJECTS_DIR || "").trim();
  if (override && isAbsolute(override)) return resolve(override);
  return join(homedir(), "Orplex Projects");
}

export type ResolveResult =
  | { ok: true; path: string; name: string }
  | { ok: false; status: number; error: string };

/**
 * Where a project with `name` goes: `<parent>/<name>`, parent defaulting to the
 * default projects dir. A client-supplied parent must be an absolute path to an
 * existing directory, and the result is jailed inside it.
 */
export async function resolveProjectDir(name: string, parent?: unknown): Promise<ResolveResult> {
  const problem = projectNameProblem(name);
  if (problem) return { ok: false, status: 400, error: projectNameMessage(problem) };
  const clean = name.trim();
  if (isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) {
    return { ok: false, status: 400, error: "Use just the project name — the folder is chosen separately" };
  }

  let base: string;
  if (typeof parent === "string" && parent.trim()) {
    if (!isAbsolute(parent.trim())) {
      return { ok: false, status: 400, error: "The chosen folder must be an absolute path" };
    }
    base = resolve(parent.trim());
    try {
      const st = await stat(base);
      if (!st.isDirectory()) return { ok: false, status: 400, error: "The chosen folder is not a directory" };
    } catch {
      return { ok: false, status: 400, error: "The chosen folder does not exist" };
    }
  } else {
    base = defaultProjectsDir();
  }

  const dest = resolve(base, clean);
  // Path jail: the name cannot walk out of `base`.
  if (basename(dest) !== clean || !dest.startsWith(resolve(base) + sep)) {
    return { ok: false, status: 400, error: "Invalid project name" };
  }
  return { ok: true, path: dest, name: clean };
}

function existsMessage(name: string): string {
  return `A folder named "${name}" already exists there`;
}

/**
 * Create an empty project folder. Refuses to reuse an existing directory: a
 * "create" that quietly adopted someone else's folder would be worse than an
 * error, because the app would then treat foreign files as this project.
 */
export async function createProjectDir(name: string, parent?: unknown): Promise<ResolveResult> {
  const target = await resolveProjectDir(name, parent);
  if (!target.ok) return target;

  const existing = await stat(target.path).catch(() => null);
  if (existing) {
    return { ok: false, status: 409, error: existsMessage(target.name) };
  }
  try {
    await mkdir(target.path);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EEXIST") return { ok: false, status: 409, error: existsMessage(target.name) };
    if (code === "ENOENT") {
      // The parent has never existed (the default projects dir on a fresh
      // install): create the chain once, then the folder itself.
      try {
        await mkdir(join(target.path, ".."), { recursive: true });
        await mkdir(target.path);
        return target;
      } catch (again) {
        const againCode = (again as { code?: string })?.code;
        if (againCode === "EEXIST") return { ok: false, status: 409, error: existsMessage(target.name) };
        return { ok: false, status: 500, error: (again as Error).message || "Could not create the project folder" };
      }
    }
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, status: 403, error: "Permission denied — pick another folder" };
    }
    return { ok: false, status: 500, error: (err as Error).message || "Could not create the project folder" };
  }
  return target;
}

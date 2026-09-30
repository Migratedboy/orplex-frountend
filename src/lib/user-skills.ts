// user-skills.ts — User-authored SKILL.md discovery (.orplex/skills/<name>/).
//
// Complements the built-in catalog in skills.ts (SKILL_CATEGORIES, used by
// the chat UI's skills menu). This module discovers USER-DEFINED skills:
//
//   <root>/.orplex/skills/<name>/SKILL.md    — project skills
//   ~/.orplex/skills/<name>/SKILL.md         — user-level skills
//
// The server agent's system prompt carries only a NAME + DESCRIPTION roster
// (~30 tokens per skill, hard-capped for the 8k-TPM free tier); the agent
// pulls a full body on demand via the `use_skill` tool. Frontmatter is a
// deliberately tiny YAML subset (key: value lines between --- fences),
// parsed with zero dependencies.

import { readdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const MAX_SKILLS = 32;
export const MAX_DESCRIPTION_CHARS = 120;
export const MAX_ROSTER_CHARS = 1_600;
export const MAX_SKILL_BODY_CHARS = 12_000;

export interface UserSkill {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  /** "project/<name>" or "user/<name>" — provenance for debugging. */
  source: string;
}

/** Minimal YAML-subset frontmatter parser (key: value lines). Zero deps. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const data: Record<string, string> = {};
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fence) return { data, body: raw.trim() };
  for (const line of fence[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { data, body: raw.slice(fence[0].length).trim() };
}

function toSkill(abs: string, source: string): UserSkill | null {
  try {
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, "utf8");
    if (!raw.trim()) return null;
    const { data, body } = parseFrontmatter(raw);
    const fallbackName = source.split("/").pop() || "skill";
    const name = (data.name || fallbackName).slice(0, 48);
    return {
      name,
      description: (data.description || "").slice(0, MAX_DESCRIPTION_CHARS),
      whenToUse: data["when-to-use"] ? data["when-to-use"].slice(0, MAX_DESCRIPTION_CHARS) : undefined,
      body: body.slice(0, MAX_SKILL_BODY_CHARS),
      source,
    };
  } catch {
    return null;
  }
}

/** Discover user skills for a workspace root (project + user level). Never throws. */
export async function loadUserSkills(rootDir: string): Promise<UserSkill[]> {
  const out: UserSkill[] = [];
  const seen = new Set<string>();

  const dirs: Array<[string, string]> = [
    [join(rootDir, ".orplex", "skills"), "project"],
    [join(homedir(), ".orplex", "skills"), "user"],
  ];
  for (const [dir, level] of dirs) {
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (out.length >= MAX_SKILLS) break;
      const skillPath = join(dir, e.name, "SKILL.md");
      const skill = toSkill(skillPath, `${level}/${e.name}`);
      if (skill && !seen.has(skill.name)) {
        seen.add(skill.name);
        out.push(skill);
      }
    }
  }
  return out;
}

/** Roster for the system prompt: name + description only, hard-capped. */
export function renderSkillRoster(skills: UserSkill[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  let total = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${s.description || "(no description)"}`;
    if (total + line.length > MAX_ROSTER_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

/** Full body of one skill for injection when the agent calls use_skill. */
export function skillBody(skills: UserSkill[], name: string): string | null {
  const s = skills.find((x) => x.name === name);
  return s ? s.body : null;
}

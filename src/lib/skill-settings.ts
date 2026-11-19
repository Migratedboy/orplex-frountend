// skill-settings.ts — persisted enabled/disabled state for the marketplace
// skill catalogue. Stored as a set of DISABLED ids so that newly published
// skills default to enabled (not in the set) and the default (no key) enables
// everything — preserving prior behavior.
//
// The catalogue itself is no longer compiled in: it arrives from the signed
// marketplace (see @/lib/marketplace-client and useMarketplaceSkills).
//
// Browser-local state (localStorage), like the shortcut overrides. Never
// contains secrets.

import type { Skill } from "@orplex/sdk/skills";

const KEY = "orplex.disabledSkills";
export const SKILL_SETTINGS_EVENT = "orplex:skills-changed";

export function loadDisabledSkillIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
  } catch {}
  return new Set();
}

export function saveDisabledSkillIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(SKILL_SETTINGS_EVENT));
  } catch {}
}

export function isSkillEnabled(id: string): boolean {
  return !loadDisabledSkillIds().has(id);
}

export function setSkillEnabled(id: string, enabled: boolean) {
  const ids = loadDisabledSkillIds();
  if (enabled) ids.delete(id);
  else ids.add(id);
  saveDisabledSkillIds(ids);
}

/** Filter a marketplace-provided skill list down to the enabled ones. */
export function enabledSkills(allSkills: readonly Skill[]): Skill[] {
  const disabled = loadDisabledSkillIds();
  return allSkills.filter((s) => !disabled.has(s.id));
}

/** Filter and group by category, dropping categories that end up empty. */
export function enabledSkillCategories(categories: Array<{ id: string; name: string; icon: string; skills: Skill[] }>) {
  const disabled = loadDisabledSkillIds();
  return categories
    .map((cat) => ({ ...cat, skills: cat.skills.filter((s) => !disabled.has(s.id)) }))
    .filter((cat) => cat.skills.length > 0);
}

export type { Skill };

// useMarketplaceSkills — client access to the signed marketplace catalogue.
//
// The skill list is no longer compiled into the app: it arrives from
// /api/marketplace/catalog, which verifies the marketplace signature server
// side. Components render with an empty list until it lands, so nothing blocks
// on the network and an offline app still works (just with no built-in skills).
"use client";

import { useEffect, useState } from "react";
import type { Skill, SkillCategory } from "@orplex/sdk/skills";

interface CatalogResponse {
  success: boolean;
  source: "network" | "cache" | "none";
  verified: boolean;
  error: string | null;
  skillCategories: Array<{ id: string; name: string; icon: string }>;
  skills: Skill[];
}

export interface MarketplaceSkillsState {
  categories: SkillCategory[];
  skills: Skill[];
  loading: boolean;
  source: "network" | "cache" | "none";
  error: string | null;
}

// Module-level cache: the picker mounts and unmounts often (menu open/close) and
// the catalogue does not change within a session.
let cached: MarketplaceSkillsState | null = null;
let inflight: Promise<MarketplaceSkillsState> | null = null;

function group(data: CatalogResponse): SkillCategory[] {
  const groups = new Map<string, SkillCategory>();
  for (const cat of data.skillCategories ?? []) {
    groups.set(cat.id, { id: cat.id, name: cat.name, icon: cat.icon, skills: [] });
  }
  for (const skill of data.skills ?? []) {
    let group$ = groups.get(skill.category);
    if (!group$) {
      group$ = { id: skill.category, name: skill.category, icon: "✨", skills: [] };
      groups.set(skill.category, group$);
    }
    group$.skills.push(skill);
  }
  return [...groups.values()].filter((g) => g.skills.length > 0);
}

async function fetchCatalog(): Promise<MarketplaceSkillsState> {
  try {
    const res = await fetch("/api/marketplace/catalog", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CatalogResponse;
    const state: MarketplaceSkillsState = {
      categories: group(data),
      skills: data.skills ?? [],
      loading: false,
      source: data.source,
      error: data.error,
    };
    cached = state;
    return state;
  } catch (err) {
    const state: MarketplaceSkillsState = {
      categories: [],
      skills: [],
      loading: false,
      source: "none",
      error: err instanceof Error ? err.message : String(err),
    };
    return state;
  }
}

export function useMarketplaceSkills(): MarketplaceSkillsState {
  const [state, setState] = useState<MarketplaceSkillsState>(
    () => cached ?? { categories: [], skills: [], loading: true, source: "none", error: null },
  );

  useEffect(() => {
    if (cached) {
      setState(cached);
      return;
    }
    let alive = true;
    inflight = inflight ?? fetchCatalog();
    void inflight.then((next) => {
      inflight = null;
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

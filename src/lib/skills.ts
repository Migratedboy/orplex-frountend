// skills.ts — the app's view of the skill catalogue.
//
// The 101 skills used to be compiled into this module. They are marketplace data
// now (signed, verified, cached — see marketplace-client.ts), so what remains
// here is the type surface and the helpers every consumer already imports.
export type { Skill, SkillCategory } from "@orplex/sdk/lib/skills";
export { flattenSkills, getSkillById, searchSkills } from "@orplex/sdk/lib/skills";

// user-skills.test.ts — Frontmatter parsing, roster token discipline, and
// body lookup for the user-authored SKILL.md loader.
import { parseFrontmatter, renderSkillRoster, skillBody, MAX_ROSTER_CHARS, type UserSkill } from "@/lib/user-skills";

describe("parseFrontmatter (zero-dep YAML subset)", () => {
  it("parses key: value lines and preserves the body", () => {
    const raw = "---\nname: deploy\ndescription: Ship it\nwhen-to-use: when releasing\n---\n\nStep one: run tests.\n";
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({ name: "deploy", description: "Ship it", "when-to-use": "when releasing" });
    expect(body).toBe("Step one: run tests.");
  });

  it("handles files without frontmatter", () => {
    const { data, body } = parseFrontmatter("just a body");
    expect(data).toEqual({});
    expect(body).toBe("just a body");
  });

  it("ignores non key:value lines inside the fence", () => {
    const { data } = parseFrontmatter("---\nname: x\nthis is not a pair\n---\nbody");
    expect(data).toEqual({ name: "x" });
  });

  it("copes with CRLF", () => {
    const { data, body } = parseFrontmatter("---\r\nname: win\r\n---\r\n\r\nbody here");
    expect(data.name).toBe("win");
    expect(body).toBe("body here");
  });
});

describe("renderSkillRoster", () => {
  it("renders name + description lines", () => {
    const skills: UserSkill[] = [
      { name: "deploy", description: "Release checklist", body: "irrelevant", source: "project/deploy" },
      { name: "review", description: "PR review pass", body: "irrelevant", source: "user/review" },
    ];
    const roster = renderSkillRoster(skills);
    expect(roster).toContain("- deploy: Release checklist");
    expect(roster).toContain("- review: PR review pass");
    expect(roster).not.toContain("irrelevant"); // bodies never leak into the roster
  });

  it("hard-caps the roster size", () => {
    const skills: UserSkill[] = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(120),
      body: "",
      source: `project/skill-${i}`,
    }));
    expect(renderSkillRoster(skills).length).toBeLessThanOrEqual(MAX_ROSTER_CHARS);
  });

  it("returns empty for no skills", () => {
    expect(renderSkillRoster([])).toBe("");
  });
});

describe("skillBody", () => {
  const skills: UserSkill[] = [{ name: "deploy", description: "", body: "THE BODY", source: "project/deploy" }];
  it("returns the full body for a known skill", () => {
    expect(skillBody(skills, "deploy")).toBe("THE BODY");
  });
  it("returns null for an unknown skill", () => {
    expect(skillBody(skills, "nope")).toBeNull();
  });
});

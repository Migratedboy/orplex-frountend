/**
 * The picker groups rows by a `group` field while each row must keep its REAL
 * provider icon.
 *
 * An earlier change routed `group` through modelCreator(), so every default
 * model lost its NVIDIA/Google/Groq mark and got one generic star instead.
 * Grouping belongs in modelCreatorId/modelCreatorLabel only.
 */

import { modelCreator, modelCreatorId, modelCreatorLabel } from "@/components/ProviderIcons";

describe("picker grouping vs row icons", () => {
  const withGroup = { key: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super", group: "Default Models" };

  it("still resolves the real provider icon for a grouped row", () => {
    const creator = modelCreator(withGroup);
    expect(creator).not.toBeNull();
    // A real registry entry, not a generic fallback.
    expect(creator!.label).not.toBe("Default Models");
    expect(creator!.Icon).toBeTruthy();
  });

  it("buckets grouped rows under one header", () => {
    expect(modelCreatorId(withGroup)).toBe("group:Default Models");
    expect(modelCreatorLabel(withGroup)).toBe("Default Models");
  });

  it("buckets two different providers in the same group together", () => {
    const nvidia = { key: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron", group: "Default Models" };
    const google = { key: "google/gemma-4-31b-it:free", name: "Gemma 4", group: "Default Models" };
    expect(modelCreatorId(nvidia)).toBe(modelCreatorId(google));
    // ...while still keeping their distinct real icons.
    expect(modelCreator(nvidia)!.Icon).toBeTruthy();
    expect(modelCreator(google)!.Icon).toBeTruthy();
  });

  it("leaves ungrouped models on creator grouping", () => {
    const plain = { key: "google/gemma-4-31b-it:free", name: "Gemma 4" };
    expect(modelCreatorId(plain)).toBe(modelCreatorId({ key: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B" }));
    expect(modelCreatorLabel(plain)).not.toBe("Default Models");
  });
});

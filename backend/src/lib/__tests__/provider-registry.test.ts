// provider-registry.test.ts — Registry integrity: every def well-formed,
// ids unique, helpers consistent, failover map derived correctly.

import {
  getProviderDef,
  listProviderDefs,
  listProviderIds,
  providerLabel,
  failoverKeyEnvMap,
} from "../provider-registry";

describe("provider-registry", () => {
  const defs = listProviderDefs();

  it("exposes the curated elite set including Claude", () => {
    const ids = listProviderIds();
    for (const required of ["groq", "nvidia", "openrouter", "anthropic", "gemini", "mistral", "deepseek", "together", "xai", "cerebras", "fireworks", "openai"]) {
      expect(ids).toContain(required);
    }
  });

  it("has unique ids", () => {
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });

  it("every def is well-formed", () => {
    for (const d of defs) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.tagline.length).toBeGreaterThan(0);
      expect(d.baseUrl).toMatch(/^https:\/\//);
      expect(d.baseUrl.endsWith("/")).toBe(false);
      expect(["bearer", "x-api-key"]).toContain(d.authStyle);
      expect(d.keyEnvVar).toMatch(/_API_KEY$/);
      expect(d.keyHintUrl).toMatch(/^https:\/\//);
      expect(d.fallbackModel.length).toBeGreaterThan(0);
      // Anthropic is the only x-api-key provider and declares its version header.
      if (d.authStyle === "x-api-key") {
        expect(d.id).toBe("anthropic");
        expect(d.extraHeaders?.["anthropic-version"]).toBeTruthy();
      }
    }
  });

  it("lookup helpers agree with the list", () => {
    expect(getProviderDef("groq")?.label).toBe("Groq");
    expect(getProviderDef("nope")).toBeUndefined();
    expect(providerLabel("groq")).toBe("Groq");
    expect(providerLabel("mystery-provider")).toBe("mystery-provider");
  });

  it("derives the failover key-env map from the registry plus custom", () => {
    const map = failoverKeyEnvMap();
    expect(map.groq).toBe("GROQ_API_KEY");
    expect(map.nvidia).toBe("NVIDIA_API_KEY");
    expect(map.openrouter).toBe("OPENROUTER_API_KEY");
    expect(map.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(map.gemini).toBe("GEMINI_API_KEY");
    // Pre-registry escape hatch preserved.
    expect(map.custom).toBe("AI_API_KEY");
  });
});

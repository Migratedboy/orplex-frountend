/**
 * @jest-environment jsdom
 */

// useModelCatalog.test — contract tests for the catalog hook extracted from
// ChatInput.tsx. Pins the picker-facing behavior that used to live inline:
//  - curated defaults are ALWAYS in the list (never a fallback-only trio),
//  - a verified row upgrades the default row in place (probe data wins,
//    the default's group survives),
//  - BYOK rows are appended and deduped by key,
//  - cold models are hidden until a wake promotion announces them,
//  - the blocking spinner only shows when nothing LIVE has landed yet.

import { renderHook, act } from "@testing-library/react";

jest.mock("@/lib/api-base", () => ({
  apiFetch: jest.fn(),
}));

import { apiFetch } from "@/lib/api-base";
import { useModelCatalog } from "@/hooks/useModelCatalog";

const mockedApiFetch = apiFetch as jest.Mock;

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

/** Default catalog shape: defaults template + whatever the test adds. */
function catalogShape(models: unknown[], extra: Record<string, unknown> = {}) {
  return okJson({
    success: true,
    models,
    health: {},
    coldModelIds: [],
    throttledModels: [],
    userModels: [],
    keysRev: "",
    providerIssues: [],
    probedAt: new Date().toISOString(),
    ...extra,
  });
}

const noopToast = () => {};

beforeEach(() => {
  mockedApiFetch.mockReset();
  // Wake-promotion polling (fires after loadCatalog) — default: none.
  mockedApiFetch.mockImplementation((url: string) => {
    if (url.startsWith("/api/notifications")) return Promise.resolve(okJson({ notifications: [] }));
    if (url === "/api/models/available") return Promise.resolve(catalogShape([]));
    if (url.startsWith("/api/models/available")) return Promise.resolve(catalogShape([]));
    return Promise.resolve(okJson({}));
  });
});

describe("useModelCatalog — picker contract", () => {
  it("always lists the curated defaults BEFORE any fetch", () => {
    const { result } = renderHook(() => useModelCatalog(noopToast));
    const keys = result.current.models.map((m) => m.key);
    expect(keys).toContain("openai/gpt-oss-120b");
    expect(keys).toContain("openrouter/free");
    // group header placement survives the merge machinery untouched
    expect(result.current.models.every((m) => m.group === "Default Models")).toBe(true);
  });

  it("a verified row upgrades the default row in place: probe data wins, group survives", async () => {
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === "/api/models/available") {
        return Promise.resolve(
          catalogShape([
            // same id as a default row, but with LIVE probe data and a fatter ctx
            { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", provider: "groq", contextWindow: 262144, free: true },
            // a fresh verified model the defaults don't know
            { id: "acme/new-model", name: "Acme New", provider: "openrouter", contextWindow: 1024 * 200, free: false },
          ])
        );
      }
      if (url.startsWith("/api/notifications")) return Promise.resolve(okJson({ notifications: [] }));
      if (url.startsWith("/api/models/available")) return Promise.resolve(catalogShape([]));
      return Promise.resolve(okJson({}));
    });
    const { result } = renderHook(() => useModelCatalog(noopToast));
    await act(async () => {
      result.current.loadCatalog();
    });
    const merged = result.current.models.find((m) => m.key === "openai/gpt-oss-120b");
    expect(merged?.group).toBe("Default Models"); // default header survives
    expect(merged?.detail).toContain("256k"); // live probe context wins over "131K"
    expect(result.current.models.some((m) => m.key === "acme/new-model")).toBe(true);
    expect(result.current.catalogLoading).toBe(false);
  });

  it("appends BYOK rows (deduped by key) after the verified pool", async () => {
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === "/api/models/available") {
        return Promise.resolve(
          catalogShape([{ id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", provider: "groq", free: true }], {
            userModels: [
              { id: "my-vendor/private-model", name: "Private Model", provider: "my-vendor", free: true },
              // duplicate of a verified id — must NOT render twice
              { id: "openai/gpt-oss-120b", name: "dup", provider: "groq", free: true },
            ],
            keysRev: "r1",
          })
        );
      }
      if (url.startsWith("/api/notifications")) return Promise.resolve(okJson({ notifications: [] }));
      if (url.startsWith("/api/models/available")) return Promise.resolve(catalogShape([]));
      return Promise.resolve(okJson({}));
    });
    const { result } = renderHook(() => useModelCatalog(noopToast));
    await act(async () => {
      result.current.loadCatalog();
    });
    const keys = result.current.models.map((m) => m.key);
    expect(keys.filter((k) => k === "openai/gpt-oss-120b")).toHaveLength(1);
    expect(keys).toContain("my-vendor/private-model");
  });

  it("hides cold models; a wake promotion un-hides them without a catalog re-publish", async () => {
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === "/api/models/available") {
        return Promise.resolve(
          catalogShape(
            [
              // a healthy model keeps visibleCount > 0 so the load finishes
              // immediately (the all-cold path schedules a 5s retry instead)
              { id: "vendor/healthy-model", name: "Healthy", provider: "vendor", free: true },
              { id: "vendor/parked-model", name: "Parked", provider: "vendor", free: true },
            ],
            { coldModelIds: ["vendor/parked-model"] }
          )
        );
      }
      if (url.startsWith("/api/notifications")) {
        return Promise.resolve(
          okJson({
            notifications: [
              {
                title: "Cold model woke up",
                message: "parked-model is awake",
                createdAt: "2026-11-04T00:00:00.000Z",
              },
            ],
          })
        );
      }
      if (url.startsWith("/api/models/available")) return Promise.resolve(catalogShape([]));
      return Promise.resolve(okJson({}));
    });
    const { result } = renderHook(() => useModelCatalog(noopToast));
    await act(async () => {
      result.current.loadCatalog();
    });
    // The wake harvest runs IN PARALLEL with the catalog fetch (that is the
    // point of it), so an announced model is already un-hidden within the
    // same load cycle — pinned real behavior.
    expect(result.current.models.some((m) => m.key === "vendor/parked-model")).toBe(true);
    expect(result.current.models.some((m) => m.key === "vendor/healthy-model")).toBe(true);
  });

  it("hides cold models when no wake promotion has announced them", async () => {
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === "/api/models/available") {
        return Promise.resolve(
          catalogShape(
            [
              { id: "vendor/healthy-model", name: "Healthy", provider: "vendor", free: true },
              { id: "vendor/parked-model", name: "Parked", provider: "vendor", free: true },
            ],
            { coldModelIds: ["vendor/parked-model"] }
          )
        );
      }
      if (url.startsWith("/api/notifications")) return Promise.resolve(okJson({ notifications: [] }));
      if (url.startsWith("/api/models/available")) return Promise.resolve(catalogShape([]));
      return Promise.resolve(okJson({}));
    });
    const { result } = renderHook(() => useModelCatalog(noopToast));
    await act(async () => {
      result.current.loadCatalog();
    });
    // Cold + no announcement → hidden; the healthy sibling stays.
    expect(result.current.models.some((m) => m.key === "vendor/parked-model")).toBe(false);
    expect(result.current.models.some((m) => m.key === "vendor/healthy-model")).toBe(true);
  });

  it("blocking spinner stays off while loading because the defaults are permanent (pinned reality)", async () => {
    // showBlockingSpinner = catalogLoading && !hasLiveModels && models.length === 0.
    // The curated defaults are ALWAYS listed, so models.length === 0 is
    // unreachable — the spinner is effectively dormant in shipped behavior.
    // Pinned as-is (behavior-preserving pass); a fix would be a deliberate
    // product change, not a refactor side effect.
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === "/api/models/available") return new Promise(() => {});
      if (url.startsWith("/api/notifications")) return Promise.resolve(okJson({ notifications: [] }));
      return Promise.resolve(okJson({}));
    });
    const { result } = renderHook(() => useModelCatalog(noopToast));
    expect(result.current.showBlockingSpinner).toBe(false);
    await act(async () => {
      result.current.loadCatalog();
    });
    expect(result.current.catalogLoading).toBe(true);
    expect(result.current.models.length).toBeGreaterThan(0); // defaults present
    expect(result.current.showBlockingSpinner).toBe(false);
  });
});

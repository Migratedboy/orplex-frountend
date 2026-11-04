// provider-failure-policy.test.ts — the failure-policy module extracted from
// /api/chat/route.ts. Pins the exact classifier regexes and the user-facing
// copy: these strings ship to the client, so a change here is a behavior
// change and must be deliberate.

import {
  isPayloadTooLargeError,
  isPermanentRejection,
  providerFailureMessage,
} from "../provider-failure-policy";

describe("isPayloadTooLargeError — the lean-retry trigger", () => {
  it("matches the real provider refusals (413 / TPM / too-large phrasing, incl. 429 TPM caps)", () => {
    expect(isPayloadTooLargeError("HTTP 413: request too large")).toBe(true);
    // A 429 that names the TPM cap IS the size lane: the lean retry is the
    // right response regardless of status code.
    expect(isPayloadTooLargeError("Error: 429 - tokens per minute (TPM) limit reached")).toBe(true);
    expect(isPayloadTooLargeError("request too large: reduce your message to continue")).toBe(true);
    expect(isPayloadTooLargeError("Groq rejected the request: tokens per minute (TPM) cap")).toBe(true);
    expect(isPayloadTooLargeError("TPM: reduce your message length")).toBe(true);
  });

  it("does NOT match transient or unrelated failures", () => {
    expect(isPayloadTooLargeError("HTTP 429 rate limit")).toBe(false);
    expect(isPayloadTooLargeError("HTTP 400 bad request")).toBe(false);
    expect(isPayloadTooLargeError("fetch timed out")).toBe(false);
    expect(isPayloadTooLargeError("")).toBe(false);
    expect(isPayloadTooLargeError(undefined)).toBe(false);
    expect(isPayloadTooLargeError(null)).toBe(false);
  });
});

describe("isPermanentRejection — retrying cannot fix these", () => {
  it("matches only the permanent HTTP 4xx class (incl. 413 after lean retry)", () => {
    for (const code of ["400", "401", "403", "404", "413", "422"]) {
      expect(isPermanentRejection(`HTTP ${code} — no go`)).toBe(true);
    }
    for (const code of ["402", "405", "409", "429", "500", "502", "503", "4130"]) {
      expect(isPermanentRejection(`HTTP ${code}`)).toBe(false);
    }
  });

  it("treats empty/missing errors as transient (never lie about permanence)", () => {
    expect(isPermanentRejection("")).toBe(false);
    expect(isPermanentRejection("unknown failure")).toBe(false);
    expect(isPermanentRejection(undefined)).toBe(false);
  });
});

describe("providerFailureMessage — shipping copy", () => {
  it("tells the user to switch models for a permanent selected-model rejection", () => {
    expect(providerFailureMessage("llama-4-maverick", "HTTP 400")).toBe(
      "The selected model (llama-4-maverick) rejected the request — it is not a problem that will fix itself. Try a different model."
    );
    expect(providerFailureMessage("gpt-5", "HTTP 413 too large")).toBe(
      "The selected model (gpt-5) rejected the request — it is not a problem that will fix itself. Try a different model."
    );
  });

  it("keeps the warming-up copy for transient selected-model failures", () => {
    expect(providerFailureMessage("qwen-max", "HTTP 429 rate limit")).toBe(
      "The selected model (qwen-max) is not responding right now - it may still be warming up on its provider. Send again in a minute or pick another model."
    );
  });

  it("uses the generic copy when no model was requested (auto routing)", () => {
    expect(providerFailureMessage(undefined, "unavailable")).toBe(
      "All AI providers are currently unavailable. Please try again."
    );
  });
});

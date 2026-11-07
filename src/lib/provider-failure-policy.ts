/**
 * provider-failure-policy.ts — how /api/chat reacts to a provider's failure.
 *
 * Extracted from /api/chat/route.ts so the classification lives in a tested
 * module instead of inline regexes in a 465-line handler. This is failure
 * POLICY (reading what a provider said, deciding retry vs permanent), not
 * transport: the caller still does the actual retry and SSE plumbing.
 *
 * Why classifiers exist (v1.0.24+/v1.0.28 history):
 * - 400/401/403/404/422 are PERMANENT: a bad parameter, bad model id or
 *   rejected tool schema will never "warm up". Telling the user to retry made
 *   a deterministic failure read as a transient outage — which is exactly how
 *   the temperature/max_tokens bugs were mis-diagnosed for weeks.
 * - 413 also belongs there: after the lean retry (the payload-size lane), a
 *   payload the provider still refuses is permanent for that model.
 */

/**
 * Did the provider refuse the request because it is TOO LARGE?
 * Matches the hard tokens-per-minute / payload-size replies. When true, the
 * caller retries the SAME provider once with a compact prompt + lean roster.
 */
export function isPayloadTooLargeError(error: unknown): boolean {
  if (!error) return false;
  return /413|too large|tokens per minute|\bTPM\b|reduce your message/i.test(String(error));
}

/** Is this rejection something retrying can NOT fix? */
export function isPermanentRejection(lastError: unknown): boolean {
  if (!lastError) return false;
  return /\bHTTP 4(00|01|03|04|13|22)\b/.test(String(lastError));
}

/**
 * The user-facing message for "every provider failed".
 * Exactly what /api/chat has always returned — wrong wording here breaks the
 * settings' failure copy contract, so tests pin these strings.
 */
export function providerFailureMessage(
  requestedModel: string | undefined,
  lastError: string
): string {
  if (requestedModel) {
    // A hard per-minute size ceiling is not a rejection of the model, so the
    // "will never work" copy above would be a lie. This is what the gpt-oss
    // free tier actually told us: "Request too large … TPM: Limit 8000".
    if (isPayloadTooLargeError(lastError)) {
      return `The request for the selected model (${requestedModel}) was too big for its per-minute token limit. The app trimmed it to fit — send again in a minute, or pick a model with a bigger limit.`;
    }
    return isPermanentRejection(lastError)
      ? `The selected model (${requestedModel}) rejected the request — it is not a problem that will fix itself. Try a different model.`
      : `The selected model (${requestedModel}) is not responding right now - it may still be warming up on its provider. Send again in a minute or pick another model.`;
  }
  return "All AI providers are currently unavailable. Please try again.";
}

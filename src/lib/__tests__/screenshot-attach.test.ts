// screenshot-attach.test.ts — browser screenshots land inline in chat.
//
// Covers the pure pieces: the markdown image line the renderer turns into an
// <img>, and the downscale fallback (no-DOM / bad input returns the original
// so the chat degrades to text-only instead of crashing).
import { screenshotMarkdown, downscaleDataUrl } from "../tool-text";

describe("screenshotMarkdown", () => {
  it("emits a markdown image with the data URL intact", () => {
    const url = "data:image/png;base64,AAA";
    const md = screenshotMarkdown(url, "browser screenshot — https://x.test");
    expect(md).toContain(`![browser screenshot — https://x.test](${url})`);
  });

  it("strips brackets from the label so the markdown can't break", () => {
    const md = screenshotMarkdown("data:image/png;base64,AAA", "a [b] c");
    expect(md).toContain("![a b c]");
  });

  it("falls back to a generic label", () => {
    expect(screenshotMarkdown("data:image/png;base64,AAA", "")).toContain("![screenshot]");
  });
});

describe("downscaleDataUrl", () => {
  it("returns non-image input unchanged", async () => {
    await expect(downscaleDataUrl("not-a-data-url")).resolves.toBe("not-a-data-url");
    await expect(downscaleDataUrl("data:text/plain,hi")).resolves.toBe("data:text/plain,hi");
  });

  it("returns the original outside a DOM (node/test env)", async () => {
    const url = "data:image/png;base64,AAA";
    await expect(downscaleDataUrl(url)).resolves.toBe(url);
  });
});

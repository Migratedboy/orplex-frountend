/**
 * Regression cover for the image-analysis honesty bugs:
 *
 *  1. With no vision backend configured, every image used to be replaced with
 *     "[Image could not be analyzed: NVIDIA_API_KEY not configured]" and that
 *     string was injected into the prompt as if it were a real caption. The
 *     model then confidently answered about an image it never saw.
 *  2. The caller reported "Image analyzed." unconditionally.
 *
 * The placeholder must be an explicit instruction to abstain, and the counters
 * must tell the truth about what happened.
 */

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageMessage() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: PNG } },
      ],
    },
  ];
}

describe("preprocessMessages image honesty", () => {
  const ORIGINAL_KEY = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    delete process.env.NVIDIA_API_KEY;
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = ORIGINAL_KEY;
  });

  it("does not fabricate a description when no vision backend is configured", async () => {
    const { preprocessMessages } = await import("@/lib/vision-preprocessor");
    const result = await preprocessMessages(imageMessage() as never, "what is this?");

    expect(result.hadImages).toBe(true);
    expect(result.analyzedImages).toBe(0);
    expect(result.failedImages).toBe(1);
  });

  it("tells the model it cannot see the image instead of captioning it", async () => {
    const { preprocessMessages } = await import("@/lib/vision-preprocessor");
    const result = await preprocessMessages(imageMessage() as never, "what is this?");

    const content = result.messages[0].content as string;
    expect(content).not.toContain("[Image could not be analyzed:");
    // The prompt must forbid guessing rather than impersonate an observation.
    expect(content).toMatch(/cannot see it/i);
    expect(content).toMatch(/do not describe/i);
    // The user's own words must survive the merge.
    expect(content).toContain("What is in this image?");
  });

  it("keeps text-only messages untouched", async () => {
    const { preprocessMessages } = await import("@/lib/vision-preprocessor");
    const result = await preprocessMessages(
      [{ role: "user", content: "hello" }] as never,
      "hello",
    );

    expect(result.hadImages).toBe(false);
    expect(result.analyzedImages).toBe(0);
    expect(result.failedImages).toBe(0);
    expect(result.messages[0].content).toBe("hello");
  });

  it("forwards image parts intact when the target model accepts images", async () => {
    // This is the whole point of picking a vision model. Preprocessing used to
    // run before routing and describe EVERY image as text, so a Gemini/Claude
    // pick in the prompt bar received zero image tokens.
    const { preprocessMessages } = await import("@/lib/vision-preprocessor");
    const result = await preprocessMessages(imageMessage() as never, "what is this?", true);

    expect(result.usedNativeVision).toBe(true);
    expect(result.failedImages).toBe(0);
    expect(result.analyzedImages).toBe(1);

    const content = result.messages[0].content as { type: string; image_url?: { url: string } }[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((p) => p.type === "image_url" && p.image_url?.url === PNG)).toBe(true);
    // No NVIDIA round-trip: the base64 must not have been described away.
    expect(result.descriptions).toHaveLength(0);
  });

  it("still describes images when the target is text-only", async () => {
    const { preprocessMessages } = await import("@/lib/vision-preprocessor");
    const result = await preprocessMessages(imageMessage() as never, "what is this?", false);

    expect(result.usedNativeVision).toBe(false);
    expect(typeof result.messages[0].content).toBe("string");
  });
});

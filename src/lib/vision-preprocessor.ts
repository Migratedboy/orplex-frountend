// vision-preprocessor.ts — Converts images to text descriptions
// Uses meta/llama-3.2-11b-vision-instruct on NVIDIA NIM (free, fast)
// GPT-OSS-120B is text-only — this module gives it "eyes"

const VISION_MODEL = "meta/llama-3.2-11b-vision-instruct";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const VISION_PROMPT = `You are a vision assistant for a coding AI. Describe this screenshot in extreme detail for a developer who will recreate it.

Focus on:
- LAYOUT: What sections exist? Sidebar? Header? Grid? Flexbox? How are things arranged?
- COLORS: Background color, accent colors, text colors (give hex codes if you can tell)
- COMPONENTS: Buttons, inputs, cards, tables, lists, icons, avatars, badges
- TYPOGRAPHY: Font weights (bold/regular), sizes relative to each other, spacing
- TEXT CONTENT: List ALL visible text — headings, labels, buttons, placeholders, menu items
- STATE: Active/selected items, hover states, loading indicators, notifications

Format your response as structured text with clear sections. This description will be used by a coding AI to build the UI.`;

interface ImageDescription {
  text: string;
  success: boolean;
  error?: string;
}

/**
 * Send an image to Llama 3.2 11B Vision and get a text description back.
 * Non-streaming — we need the full description before proceeding.
 */
export async function describeImage(
  imageBase64: string,
  userPrompt: string
): Promise<ImageDescription> {
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    return { text: "", success: false, error: "NVIDIA_API_KEY not configured" };
  }

  const dataUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/png;base64,${imageBase64}`;

  const body = JSON.stringify({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${VISION_PROMPT}\n\nUser's request: ${userPrompt}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 1000,
    temperature: 0.3,
    stream: false,
  });

  try {
    const res = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return { text: "", success: false, error: `Vision model HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return { text: "", success: false, error: "Vision model returned empty response" };
    }

    return { text: content, success: true };
  } catch (err) {
    return { text: "", success: false, error: (err as Error).message };
  }
}

/**
 * Process messages — if any message has images, replace them with text descriptions.
 * Returns modified messages that GPT-OSS-120B (text-only) can understand.
 */
export async function preprocessMessages(
  messages: Array<{ role: string; content: any }>,
  userPrompt: string
): Promise<{
  messages: Array<{ role: string; content: any }>;
  hadImages: boolean;
  descriptions: string[];
}> {
  const descriptions: string[] = [];
  let hadImages = false;

  const processed = await Promise.all(
    messages.map(async (msg) => {
      // Check if content is multimodal (array with image_url parts)
      if (Array.isArray(msg.content)) {
        const imageParts = msg.content.filter(
          (p: any) => p.type === "image_url" && p.image_url?.url
        );

        if (imageParts.length === 0) {
          return msg; // No images — pass through
        }

        hadImages = true;

        // Extract text part from the multimodal content
        const textPart = msg.content.find((p: any) => p.type === "text");
        const originalText = textPart?.text || "";

        // Describe each image
        for (const img of imageParts) {
          const imgUrl = img.image_url.url;
          const base64 = imgUrl.startsWith("data:")
            ? imgUrl.split(",")[1] || imgUrl
            : imgUrl;

          const result = await describeImage(base64, userPrompt);

          if (result.success && result.text) {
            descriptions.push(result.text);
          } else {
            // Fallback — tell the model the image couldn't be processed
            descriptions.push(`[Image could not be analyzed: ${result.error || "unknown error"}]`);
          }
        }

        // Replace multimodal content with text description
        const descriptionText = descriptions.length > 0
          ? descriptions.map((d, i) => `[IMAGE ${i + 1} DESCRIPTION]:\n${d}`).join("\n\n")
          : "";

        const mergedContent = `${originalText}\n\n${descriptionText}`.trim();

        return { role: msg.role, content: mergedContent };
      }

      return msg;
    })
  );

  return { messages: processed, hadImages, descriptions };
}

export interface DefaultModelRow {
  key: string;
  name: string;
  tag: string;
  detail?: string;
  group?: string;
}

export const DEFAULT_MODELS: DefaultModelRow[] = [
  { key: "openrouter/free", name: "Free Models Router", tag: "OpenRouter", detail: "free · 200K · tools · always available", group: "Default Models" },
  { key: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", tag: "OpenRouter", detail: "free · 1M", group: "Default Models" },
  { key: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL", tag: "OpenRouter", detail: "free · 1M · vision · video", group: "Default Models" },
  { key: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning", tag: "OpenRouter", detail: "free · 1M", group: "Default Models" },
  { key: "dots-studio/dots-3-note-preview:free", name: "Dots3-Note Preview", tag: "OpenRouter", detail: "free · 512K · vision", group: "Default Models" },
  { key: "recursive/flint-v1.0:free", name: "Recursive Flint", tag: "OpenRouter", detail: "free · 262K", group: "Default Models" },
  { key: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B", tag: "OpenRouter", detail: "free · 262K · vision", group: "Default Models" },
  { key: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", tag: "OpenRouter", detail: "free · 262K · vision", group: "Default Models" },
  { key: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni", tag: "OpenRouter", detail: "free · 256K · vision", group: "Default Models" },
  { key: "liquid/lfm-3-1.7b:free", name: "LFM 3 1.7B", tag: "OpenRouter", detail: "free · 262K · compact", group: "Default Models" },
];

export const OPT_IN_MODELS: DefaultModelRow[] = [];
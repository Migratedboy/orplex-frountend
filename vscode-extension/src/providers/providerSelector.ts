import * as vscode from "vscode";

/**
 * Available AI providers with their default models.
 */
export interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    models: ["qwen/qwen3.8-27b:free", "anthropic/claude-sonnet-4", "meta-llama/llama-3.1-70b-instruct"],
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    models: ["openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b"],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4-20250514", "claude-3-haiku-20240307"],
  },
];

/**
 * Show a quick-pick to let the user switch provider/model.
 */
export async function pickProvider(
  config: vscode.WorkspaceConfiguration,
): Promise<{ provider: string; model: string } | undefined> {
  const items: vscode.QuickPickItem[] = [];

  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      items.push({
        label: model,
        description: provider.label,
        picked: model === config.get("model"),
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select AI model",
    title: "Orplex — Switch Model",
  });

  if (!picked) return undefined;

  const provider = PROVIDERS.find((p) => p.label === picked.description);
  return {
    provider: provider?.id || "openrouter",
    model: picked.label,
  };
}

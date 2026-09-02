import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

interface ConfigOptions {
  url?: string;
  apiKey?: string;
  mode?: string;
}

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || ".", "orplex");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface ConfigData {
  url: string;
  apiKey: string;
  mode: string;
}

function loadConfig(): ConfigData {
  const defaults: ConfigData = {
    url: "http://localhost:5000",
    apiKey: "",
    mode: "code",
  };

  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }

  return defaults;
}

function saveConfig(config: ConfigData): void {
  const { mkdirSync } = require("fs");
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Config command — view or set configuration.
 *
 * Usage:
 *   orplex config              — show current config
 *   orplex config --url <url>  — set API URL
 *   orplex config --api-key <k> — set API key
 *   orplex config --mode <m>   — set default mode
 */
export async function configCommand(options: ConfigOptions): Promise<void> {
  const config = loadConfig();
  const hasChanges = options.url || options.apiKey || options.mode;

  if (!hasChanges) {
    // Display current config
    console.log(chalk.bold("\n⚙  Orplex CLI Configuration\n"));
    console.log(`  ${chalk.bold("API URL:")}   ${config.url}`);
    console.log(`  ${chalk.bold("API Key:")}   ${config.apiKey ? chalk.dim("(set)") : chalk.dim("(not set)")}`);
    console.log(`  ${chalk.bold("Mode:")}      ${config.mode}`);
    console.log(`  ${chalk.bold("Config:")}    ${chalk.dim(CONFIG_FILE)}\n`);
    return;
  }

  // Update config
  if (options.url) config.url = options.url;
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.mode) {
    if (!["ask", "plan", "code"].includes(options.mode)) {
      console.log(chalk.red("Invalid mode. Must be: ask, plan, or code"));
      process.exit(1);
    }
    config.mode = options.mode;
  }

  saveConfig(config);
  console.log(chalk.green("✓ Configuration updated\n"));

  // Show updated config
  console.log(`  ${chalk.bold("API URL:")}   ${config.url}`);
  console.log(`  ${chalk.bold("API Key:")}   ${config.apiKey ? chalk.dim("(set)") : chalk.dim("(not set)")}`);
  console.log(`  ${chalk.bold("Mode:")}      ${config.mode}\n`);
}

export { loadConfig };

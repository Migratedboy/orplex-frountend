#!/usr/bin/env node

import { Command } from "commander";
import { chatCommand } from "./commands/chat.js";
import { statusCommand } from "./commands/status.js";
import { doctorCommand } from "./commands/doctor.js";
import { configCommand, loadConfig } from "./commands/config.js";
import { conversationsCommand } from "./commands/conversations.js";

const config = loadConfig();

const program = new Command();

program
  .name("orplex")
  .description("Orplex Tech CLI — AI coding assistant in your terminal")
  .version("0.1.0");

program
  .command("chat [message...]")
  .description("Chat with Orplex AI (supports piped input)")
  .option("-m, --mode <mode>", "Agent mode (ask, plan, code)", config.mode)
  .option("-u, --url <url>", "Orplex server URL", config.url)
  .option("-k, --api-key <key>", "API key", config.apiKey)
  .action(chatCommand);

program
  .command("status")
  .description("Check Orplex server status")
  .option("-u, --url <url>", "Orplex server URL", config.url)
  .action(statusCommand);

program
  .command("doctor")
  .description("Run health checks on your Orplex setup")
  .option("-u, --url <url>", "Orplex server URL", config.url)
  .option("-k, --api-key <key>", "API key", config.apiKey)
  .action(doctorCommand);

program
  .command("config")
  .description("View or set CLI configuration")
  .option("--url <url>", "Set API URL")
  .option("--api-key <key>", "Set API key")
  .option("--mode <mode>", "Set default mode (ask, plan, code)")
  .action(configCommand);

program
  .command("conversations")
  .description("List recent conversations")
  .option("-u, --url <url>", "Orplex server URL", config.url)
  .option("-k, --api-key <key>", "API key", config.apiKey)
  .option("-n, --limit <n>", "Number of conversations to show", "10")
  .action((opts) => conversationsCommand({ ...opts, limit: parseInt(opts.limit, 10) }));

program.parse();

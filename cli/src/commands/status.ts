import chalk from "chalk";

interface StatusOptions {
  url: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  console.log(chalk.dim(`Checking ${options.url}...`));

  try {
    const res = await fetch(`${options.url}/api/health`);
    const data = await res.json();

    if (data.status === "healthy") {
      console.log(chalk.green("✓ Orplex is running"));
    } else {
      console.log(chalk.yellow("⚠ Orplex is degraded"));
    }

    console.log(chalk.dim(`  Uptime: ${Math.round(data.uptime / 60)}m`));
    console.log(chalk.dim(`  Memory: ${data.checks?.memory || "unknown"}`));
    console.log(chalk.dim(`  Database: ${data.checks?.database || "unknown"}`));
  } catch (err: any) {
    console.log(chalk.red("✗ Cannot connect to Orplex server"));
    console.log(chalk.dim(`  URL: ${options.url}`));
    console.log(chalk.dim(`  Error: ${err.message}`));
  }
}

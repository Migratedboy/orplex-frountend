import React from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import styles from "./index.module.css";

const features = [
  {
    title: "AI Coding Agent",
    description:
      "Streaming chat with real-time tool calling. The agent reads, writes, edits files and runs commands autonomously — with your approval.",
    icon: "🤖",
  },
  {
    title: "3 Agent Modes",
    description:
      "Ask for quick answers, Plan for architecture, or Code for building and fixing. Switch modes to match your task.",
    icon: "⚡",
  },
  {
    title: "Multi-Provider",
    description:
      "Connect OpenRouter, NVIDIA, OpenAI, Anthropic, or any OpenAI-compatible API. Bring your own keys — zero marginal cost.",
    icon: "🔌",
  },
  {
    title: "BYOK Frontier Mode",
    description:
      "Set AI_PROVIDER=custom with any OpenAI-compatible endpoint and your own Claude, Gemini, or OpenRouter key. Per-run model overrides, and the Manager badge always shows which mode is live.",
    icon: "🔑",
  },
  {
    title: "Morning PR Queue",
    description:
      "Queue tasks for 02:00 (or stagger a batch via the API) and the serial executor sips through them overnight — one run at a time, free-tier friendly. Branches are pushed with PR or compare links: wake up, review the diff, merge.",
    icon: "🌙",
  },
  {
    title: "Audit Bundle",
    description:
      "Every run exports one tamper-evident JSON file: SHA-256 hash-chained events, artifacts, and approval decisions, plus a human-readable manifest. A verify endpoint recomputes the chain — provable agents, not vibes.",
    icon: "🧾",
  },
  {
    title: "Risk-Tiered Safety",
    description:
      "Reads auto-approve, writes require consent, destructive ops get flagged. Diff view with accept/reject per hunk.",
    icon: "🛡️",
  },
  {
    title: "Plugin System",
    description:
      "Built-in plugins with a curated keep-list on by default — secret scanner, path guard, cost tracker. Enable more per workspace.",
    icon: "🧩",
  },
  {
    title: "Context Discipline",
    description:
      "Summarizing compaction preserves decisions instead of dropping old turns, evidence-gated workspace memory re-enters prompts, and MCP servers plug external tools into the loop.",
    icon: "🧠",
  },
  {
    title: "Deploy Anywhere",
    description:
      "Self-host with Docker/Podman in one command. Next.js + PostgreSQL stack. JWT auth, admin dashboard, usage analytics.",
    icon: "🌐",
  },
  {
    title: "Use Everywhere",
    description:
      "Full web IDE, VS Code extension, CLI tool, and REST API. Use it however you work.",
    icon: "💻",
  },
];

function Feature({ title, description, icon }) {
  return (
    <div className={clsx("col col--3")}>
      <div className="text--center">
        <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>{icon}</div>
      </div>
      <div className="text--center padding-horiz--md">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx("hero hero--primary", styles.heroBanner)}>
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/install">
            Get Started →
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/docs/api/chat"
            style={{ marginLeft: "1rem", color: "white", borderColor: "white" }}
          >
            API Reference
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}

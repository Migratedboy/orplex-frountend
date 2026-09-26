# Positioning

**Orplex is the open, local, auditable coding agent.**
Runs on a 2015-era ThinkPad, no account, no telemetry, every run a git branch.

## The category

Antigravity sells a cloud agent backed by Google infrastructure. Claude Code sells Anthropic's harness with Anthropic's pricing. Orplex is the third thing: **the agent harness you own** — open source, local-first, and built so every artifact of every run is inspectable with plain tools.

## The spec story

The reference minimum spec is the machine Orplex is developed on:

| | |
|---|---|
| CPU | Intel i5-8350U (4C/8T, 2018) |
| RAM | 8 GB |
| GPU | Integrated (none used) |
| OS | Windows 10/11 |

Design consequences, all deliberate:

- **No containers, no sandboxes, no local models.** Those are RAM sinks. Isolation comes from git worktrees — free, instant, inspectable.
- **Serial execution by default.** On an 8k-TPM free tier, parallel writes are self-defeating. The morning PR queue sips through scheduled runs overnight instead.
- **No heavy SDKs.** MCP is implemented against the stdio wire protocol directly (~150 lines, zero dependencies). OpenAI-compatible HTTP covers BYOK for every frontier provider.
- **Subprocess discipline.** Every spawned process gets a timeout; MCP servers cap at 2 and are idle-reaped in 5 minutes; nothing holds the event loop open.
- **Windows-first utilities.** Search runs `rg` → `git grep` → pure Node; no Unix assumptions.

## The audit story

Every run produces:

1. A **git branch** — review the diff with any tool, merge or discard explicitly.
2. A **timeline** — sequence-corrected lifecycle events.
3. An **audit bundle** — one JSON file: run record, SHA-256 hash-chained events (tamper-evident), artifacts, approval decisions, and a human-readable manifest. A compliance officer reads `manifest.md`; a script recomputes the chain.
4. **Approvals** — risky commands pause the run; the decision is recorded with who and when.

Nothing phones home. The BYOK mode means your key, your provider, your data — Orplex ships no proxy of its own.

## What Orplex is not

- Not a cloud product. There is no hosted version to sign up for.
- Not a model. BYOK points it at any frontier model you have a key for; the free tier works without one.
- Not a monolith. The plugin API is a small keep-list, not twenty-five loosely-wired modules; vestigial code is deleted, not decorated.

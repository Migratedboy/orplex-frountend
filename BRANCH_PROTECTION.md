# Branch Protection Rules

This document describes the recommended branch protection configuration for the Orplex Code repository.

## Setup Instructions

Configure these rules in **GitHub → Settings → Branches → Add branch protection rule**.

---

## `main` Branch (Production)

| Rule | Setting |
|------|---------|
| **Branch name pattern** | `main` |
| **Require a pull request before merging** | ✅ Enabled |
| Required approvals | 1 |
| Dismiss stale reviews on new pushes | ✅ Enabled |
| Require review from code owners | ✅ Enabled |
| **Require status checks before merging** | ✅ Enabled |
| Required checks | `Lint & TypeCheck`, `Tests`, `Build` |
| Require branches to be up to date | ✅ Enabled |
| **Require conversation resolution** | ✅ Enabled |
| **Require signed commits** | ⬜ Optional (recommended for production) |
| **Require linear history** | ⬜ Optional (enforces squash or rebase) |
| **Do not allow bypassing the above settings** | ✅ Enabled (including admins) |
| **Restrict who can push to matching branches** | ⬜ Optional — leave open if using squash-merge |
| **Allow force pushes** | ❌ Disabled |
| **Allow deletions** | ❌ Disabled |

### What this means in practice:
- No one can push directly to `main` — all changes go through PRs
- Every PR needs at least 1 approval from a code owner
- CI must pass (lint, typecheck, tests, build) before merge is allowed
- Stale approvals are dismissed when new commits are pushed
- Branch must be rebased on latest `main` before merge

---

## `develop` Branch (Integration)

| Rule | Setting |
|------|---------|
| **Branch name pattern** | `develop` |
| **Require a pull request before merging** | ✅ Enabled |
| Required approvals | 1 |
| Dismiss stale reviews on new pushes | ✅ Enabled |
| **Require status checks before merging** | ✅ Enabled |
| Required checks | `Lint & TypeCheck`, `Tests` |
| **Require conversation resolution** | ✅ Enabled |
| **Allow force pushes** | ❌ Disabled |
| **Allow deletions** | ❌ Disabled |

### What this means in practice:
- Feature branches merge into `develop` via PR
- Build check is not required (faster iteration)
- All other protection rules apply

---

## Feature Branches (`feature/*`, `fix/*`)

No branch protection rules needed — these are ephemeral branches.

**Recommended naming convention:**
```
feature/add-billing
feature/vscode-inline-chat
fix/quota-reset-bug
chore/update-deps
docs/add-api-reference
```

---

## Release Tags

Tags are protected by the `Do not allow deletions` rule on `main`.

**Tag naming convention:**
```
vscode-v0.1.0    → triggers VS Code Marketplace publish
cli-v0.1.0       → triggers npm publish
v1.0.0           → general release tag
```

---

## Required Secrets

These repository secrets must be configured for CI/CD workflows:

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `VSCE_PAT` | VS Code Marketplace publish | [Azure DevOps PAT](https://dev.azure.com) with `Marketplace > Manage` scope |
| `NPM_TOKEN` | npm publish | [npm access token](https://www.npmjs.com) with `Automation` type |

**Setup:**
1. Go to **GitHub → Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Add each secret with the name and value from the table above

---

## CODEOWNERS

The `.github/CODEOWNERS` file defines automatic review assignments:

| Pattern | Team | Reviews required for |
|---------|------|---------------------|
| `*` | `@orplex-tech/core` | All files (default) |
| `src/lib/background-worker.ts` etc. | `@orplex-tech/ai` | AI/agent changes |
| `vscode-extension/` | `@orplex-tech/vscode` | VS Code extension |
| `cli/` | `@orplex-tech/cli` | CLI tool |
| `docs-site/` | `@orplex-tech/docs` | Documentation |
| `.github/`, `Containerfile` | `@orplex-tech/devops` | Infrastructure |
| `src/lib/auth.ts`, `key-encryption.ts` | `@orplex-tech/security` | Security-sensitive code |

**Note:** These teams must be created in the GitHub organization first. Until then, the `*` default rule assigns `@orplex-tech/core` to all PRs.

---

## Quick Setup Checklist

- [ ] Enable branch protection on `main` (see above)
- [ ] Enable branch protection on `develop` (see above)
- [ ] Create GitHub teams: `core`, `ai`, `vscode`, `cli`, `docs`, `devops`, `security`
- [ ] Add `VSCE_PAT` secret for VS Code publishing
- [ ] Add `NPM_TOKEN` secret for CLI publishing
- [ ] Enable GitHub Pages (source: `gh-pages` branch) for docs
- [ ] Enable Dependabot alerts and security updates
- [ ] Set default branch to `main` in repo settings

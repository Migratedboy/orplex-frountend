# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | ✅ Active support  |
| < 1.0   | ⚠️ Security fixes only |

## Reporting a Vulnerability

We take the security of Orplex Code seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **chandyash400@gmail.com**

Include the following in your report:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if any)

### What to Expect

| Step | Timeline |
|------|----------|
| Acknowledgment of your report | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix developed and tested | Within 30 days for critical issues |
| Public disclosure (after fix) | Coordinated with reporter |

### Scope

The following are in scope for security reports:

- **Remote code execution** — Any path where the agent can execute arbitrary commands outside the sandbox
- **Authentication bypass** — Ways to access protected routes without valid credentials
- **Authorization escalation** — Regular users accessing admin endpoints
- **Injection attacks** — SQL injection, prompt injection that bypasses detection, XSS in the web UI
- **Path traversal** — Reading or writing files outside the workspace
- **API key exposure** — Leaking encrypted or decrypted API keys
- **Rate limiting bypass** — Circumventing burst or daily quota limits
- **Denial of service** — Crash or resource exhaustion via crafted input

### Out of Scope

- Issues in third-party dependencies (report upstream)
- Social engineering attacks
- Issues requiring physical access to the server
- UI/UX issues that don't have security impact

## Security Best Practices for Self-Hosters

If you're running your own Orplex instance:

- **Use HTTPS** in production — never expose the app over plain HTTP
- **Set a strong `NEXTAUTH_SECRET`** — generate with `openssl rand -base64 32`
- **Restrict `ALLOWED_ORIGINS`** to your domain
- **Run behind a reverse proxy** (nginx, Caddy) with rate limiting
- **Keep dependencies updated** — run `npm audit` regularly
- **Use environment variables** for all secrets — never commit `.env` files
- **Enable PostgreSQL SSL** for remote database connections
- **Set resource limits** in Docker/Podman compose (CPU, memory)

## Data Handling

- API keys are encrypted at rest using **AES-256-GCM**
- User sessions use **JWT with database backing**
- No user code or prompts are stored beyond the current conversation
- Usage logs contain only metadata (provider, model, token counts, latency) — no content
- Automated backups include only database dumps, not API keys

## Dependency Security

- We use `npm audit` in CI to catch known vulnerabilities
- Dependabot is configured for automatic dependency update PRs
- Critical vulnerabilities are patched within 72 hours

## Contact

For any security concerns, contact: **security@orplex.dev**

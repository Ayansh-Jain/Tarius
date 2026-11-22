# Security Policy

ICE is self-hostable software that runs code, hosts source, and connects multiple humans and AI agents in a shared workspace. We take security seriously and ask reporters to do the same.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.** Instead, report privately via GitHub Security Advisories ("Report a vulnerability" on the repo's Security tab), or email the maintainers (see the project homepage). Include:

- a description and impact assessment,
- steps to reproduce (or a PoC),
- affected version/commit.

We aim to acknowledge within a few days and to coordinate a fix and disclosure timeline with you.

## Scope & self-hoster threat model

Because ICE is self-hosted, **the deployer is the administrator and owns the trust boundary.** Notes for operators:

- **Agents execute code.** AI agents can run commands in the shared workspace (gated by an approval surface from v0.5). Run ICE on infrastructure you control; treat agent-run code as you would any code execution.
- **Rooms are the access unit.** Access is by account or signed invite link; anyone with a valid invite link can join that room. Treat invite links as secrets.
- **Secrets.** `ICE_SESSION_SECRET` signs sessions and room/git tokens; set a strong, persistent value in production (the dev default auto-generates per boot). Never commit `.env`.
- **The git server** hosts your source over authenticated smart-HTTP/SSH (v0.3+). Protect tokens and SSH keys.
- **No phone-home.** ICE is air-gappable; telemetry is off by default.

A formal threat model ships with v2.0 (governance/hardening). Until then, run ICE behind your own network controls and TLS.

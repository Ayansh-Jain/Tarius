# Contributing to ICE

Thanks for helping build ICE — the open-source collaborative environment where humans and AI agents code together in one live room. This guide is short on purpose.

## Ground rules

- **License:** ICE is **Apache-2.0**, one license across the whole repo. By contributing, you agree your contributions are licensed under it.
- **No CLA.** We use the **DCO** instead (see below). We never ask you to sign away copyright.
- **Stay on-thesis.** Read [docs/VISION.md](docs/VISION.md) ("What ICE is NOT") and [docs/DECISIONS.md](docs/DECISIONS.md). Features outside the current release spec get flagged for the next planning round, not merged ad hoc.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying you wrote the code (or have the right to submit it) per the [DCO](https://developercertificate.org/). Add a sign-off line to each commit:

```
git commit -s -m "your message"
```

This appends `Signed-off-by: Your Name <you@example.com>` (must match your git author identity). PRs with unsigned commits won't be merged.

## Getting set up

```bash
pnpm install          # Node 22+, pnpm 9+
pnpm dev              # run web (:3000) + server (:8080) in watch mode
pnpm typecheck        # tsc across the workspace
pnpm build            # build everything
```

Self-host the full stack with `docker compose up`.

## Code style

- **TypeScript everywhere**, ESM, strict mode. Match the surrounding code's idiom and comment density.
- Keep the protocol/domain vocabulary in `packages/shared`; don't fork types per app.
- Respect the **architectural law** (ADR-000): the Yjs doc is the single source of truth for open files; never write the filesystem behind the CRDT's back.
- Small, scoped commits. `pnpm typecheck` and `pnpm build` must pass before you open a PR.

## How work is organized

ICE is built release by release (see [docs/ROADMAP.md](docs/ROADMAP.md)); each release has a spec in [`plans/releases/`](plans/releases/) with a checklist. New to the codebase (human or agent)? Start with [docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md) and the live [PROGRESS.md](PROGRESS.md).

## Reporting bugs / proposing features

Use the GitHub issue templates. Security issues: see [SECURITY.md](SECURITY.md) — please don't open public issues for vulnerabilities.

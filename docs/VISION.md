# ICE — Vision

## What we're building

**ICE (Integrated Collaborative Environment)** is the best open-source collaborative IDE: a place where a small team of friends — humans and AI agents together — write software in one shared, live workspace, talk over voice and chat, and run it all on infrastructure they own.

## The core insight

The 2026 agentic-coding landscape split into two opposite shapes:

- **Isolation** (the crowd): every agent gets its own git worktree/container on a separate branch; a human reconciles the branches later. Great for "run 5 agents on 5 tasks," but the agents never see each other and never collaborate. (Claude Squad, Sculptor, Composio AO, Conductor, ccswarm…)
- **Shared** (the frontier, mostly unbuilt in OSS): humans and multiple agents inhabit **one** live workspace — same files, same cursors, same context — coordinating in real time. (Zed, OpenAgents, GitHub Next's "Ace" prototype.)

**ICE is unapologetically a _shared_ workspace.** That is the differentiator and the reason to build. CRDTs (Yjs) make it conflict-free; the same multiplayer fabric that carries human edits carries agent edits.

## Who it's for

A **squad of 2–8 friends** building something together — a hackathon team, a small startup, an open-source crew, a class project — who want their AI collaborators _in the room_, not in a side channel.

## The four pillars

1. **AI agent chat (and multi-agent).** A first-class agent you _talk to_, that acts in the shared workspace. Then: more than one agent, coordinating without trampling each other. This is the heart of the product.
2. **Human comms in-app.** Voice rooms, group chat, DMs. You should never need Discord open next to ICE.
3. **Real-time collaborative coding.** Live shared editing, presence, shared cursors, shared terminals. Google-Docs-for-code.
4. **Self-hostable, with its own git server.** One server you run yourself that includes source hosting. No external forge required to be fully functional.

## What ICE is NOT (anti-bloat charter)

- ❌ Not a VS Code fork. (Marketplace/extension-enforcement risk; heavyweight; we want a focused, web-native surface.)
- ❌ Not an enterprise platform. No SSO/SAML/RBAC matrices, audit logs, or admin consoles in the core. Squads, not orgs.
- ❌ Not a marketplace / plugin ecosystem (at least not before v2). Curated, batteries-included beats infinite extensibility.
- ❌ Not a Kubernetes-native cloud-dev-environment product. `docker compose up` on one box is the target, not a control plane.
- ❌ Not a general project-management tool. No kanban boards, tickets, or wikis baked in.

Every feature must serve a squad coding together _right now_. If it doesn't, it's bloat.

## Definition of "done" for v2

A group of friends can: spin up ICE on their own server with one command → open a shared repo hosted on ICE's own git server → edit code together live → talk over voice → and bring one or more AI agents into the same workspace to pair with them — with the agents coordinating safely in shared context.

## Guiding principles

- **Small lovable core, shipped fast.** Each release is independently demoable.
- **Steal the best, ship none of the mess.** Learn from the field (see [COMPETITION.md](COMPETITION.md)); copy what's loved, drop what's bloat.
- **Adopt protocols, don't reinvent them.** ACP (editor↔agent), MCP (agent↔tools), WebRTC/LiveKit (voice), Yjs (CRDT), Git (source).
- **Local-first & forkable.** Permissive defaults, self-host forever, no lock-in.

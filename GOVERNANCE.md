# ICE Governance

> **The "forkable forever" promise, made formal.** ICE is open-source self-hostable software (Apache-2.0). This document is the social contract that makes that promise durable: who decides what, how decisions are made in the open, and what guarantees no single party — including the founders — can take ICE away from its community.
>
> Status: **v1 (ratified for v2.0).** Changes to this document follow the [RFC process](docs/rfcs/README.md) and require a supermajority of maintainers (see [Changing this document](#changing-this-document)).

---

## 1. Principles

ICE's [fourth pillar](docs/DECISIONS.md) is **"own your stack — permissively licensed, forkable forever."** Governance exists to keep that true in practice, not just in the license file. Four principles bind everything below:

1. **Forkable forever.** The license is **Apache-2.0** across the whole repo ([CONTRIBUTING.md](CONTRIBUTING.md)). No part of ICE may add a license that restricts the right to fork, run, or self-host. The fork is the community's ultimate check on the maintainers — governance succeeds by making forking *unnecessary*, never by making it *impossible*.
2. **Vendor-neutral.** No single company's commercial interest gets privileged treatment in the codebase, the roadmap, or the decision process. If a company stewards the trademark (see §6), it does so on behalf of the project, not the other way around.
3. **Decide in the open.** Substantial changes are proposed, debated, and recorded publicly via [RFCs](docs/rfcs/README.md) and the [decision log](docs/DECISIONS.md). "Why is it this way?" should always have a written, linkable answer.
4. **Low ceremony.** Governance is the minimum structure that protects the above. We add process only when a real problem demands it, and we prefer a lightweight convention over a heavyweight rule. (ICE is built release-by-release by a small team plus an autonomous agent crew; the process must not outweigh the work.)

---

## 2. Roles

ICE recognises three contributor roles. Roles describe **responsibility and trust**, not status; they are granted and removed by the maintainers, transparently.

### Contributor
Anyone who opens an issue, a PR, an RFC, or otherwise helps. No prerequisite beyond following [CONTRIBUTING.md](CONTRIBUTING.md) (Apache-2.0 + [DCO sign-off](#3-licensing--dco-no-cla), stay on-thesis). Contributors do not need commit access — they propose, review, and discuss.

### Maintainer
A contributor trusted with **write access** to a part of the repo and a **binding vote** in decisions. Maintainers:

- review and merge PRs (enforcing the [architectural law, ADR-000](docs/DECISIONS.md): Yjs is the single source of truth; agents write through the doc);
- shepherd RFCs and record outcomes in the [decision log](docs/DECISIONS.md);
- triage issues, cut releases, and uphold the [Code of Conduct](#7-code-of-conduct);
- carry an **area of responsibility** (see [Areas](#areas-codeowners)) — e.g. *sync/CRDT*, *git server*, *agent host*, *voice*, *web*, *security*.

**Becoming a maintainer:** a sustained track record of quality contributions and good judgement in review, proposed by an existing maintainer and confirmed by [lazy consensus](#5-decision-making) of the maintainers. There is no fixed contribution count — trust is earned, not counted.

**Stepping down / inactivity:** maintainers may step down at any time (and are thanked, not penalised). A maintainer inactive for **6 months** moves to *emeritus* (retains credit, drops the binding vote and write access) and can be reinstated on return. This keeps the active voter set real.

### Steward (Lead Maintainer)
A small number (initially **1–3**) of maintainers who hold the **tie-breaking** responsibility and the cross-cutting duties no single area owns: security response coordination ([SECURITY.md](SECURITY.md)), release sign-off, trademark/foundation stewardship (§6), and final say when [decision-making](#5-decision-making) deadlocks. Stewardship is a *duty*, not ownership — a steward has no power to relicense, sell, or close the project (the [guarantees](#8-what-cannot-change) forbid it). Stewards are chosen by the maintainers and rotate or expand as the project grows.

### Areas (CODEOWNERS)
Each subsystem has at least one maintainer of record, mirrored in a repo `CODEOWNERS` file so reviews route automatically:

| Area | Scope | Source of truth |
|---|---|---|
| sync / CRDT | Yjs + Hocuspocus, convergence | `apps/server/src/{realtime,convergence}`, ADR-000/003 |
| git server | bundled git, commit projection | `apps/server/src/git` |
| agent host | ACP, multi-agent orchestrator, policy, MCP | `apps/server/src/{agent,orchestrator,agent-policy,mcp}` |
| comms | voice, chat, presence | `apps/server/src/voice`, `apps/web` comms |
| web | editor, panels, UX | `apps/web` |
| extensions | community extension surface | `apps/server/src/extensions`, [docs/EXTENSIONS.md](docs/EXTENSIONS.md) |
| security | threat model, advisories, hardening | [SECURITY.md](SECURITY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) |
| docs / governance | this file, RFCs, roadmap | `docs/`, `plans/` |

---

## 3. Licensing & DCO (no CLA)

- **One license: Apache-2.0**, repo-wide. By contributing you agree your contribution is licensed under it ([CONTRIBUTING.md](CONTRIBUTING.md), [NOTICE](NOTICE), [LICENSE](LICENSE)).
- **No CLA — ever.** ICE uses the **[Developer Certificate of Origin](https://developercertificate.org/)**. Every commit is signed off (`git commit -s`), certifying you have the right to submit it. We deliberately do **not** ask contributors to assign copyright to any company or person. This is a structural guarantee: because no entity aggregates copyright, **no entity can unilaterally relicense ICE** — relicensing would require the consent of all contributors, which is exactly the friction that protects the commons.
- **Copyright stays with contributors.** Each contributor (or their employer, per their own agreements) retains copyright in their contribution; the project holds an Apache-2.0 license to it. The [NOTICE](NOTICE) file credits "ICE contributors" collectively.
- **Inbound = outbound.** What flows in under Apache-2.0 flows out under Apache-2.0. Dependencies must carry compatible licenses (see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)); a dependency whose license restricts self-hosting or forking is disqualified.

---

## 4. The RFC process

Substantial changes — anything that affects the architecture, a public contract, the threat model, the roadmap thesis, or governance itself — go through a public, written **RFC** before implementation. Small, obvious, or reversible changes do **not** need an RFC; a regular PR is enough.

The full process, the lifecycle (`draft → discussion → final-comment → accepted/rejected → implemented`), and what *requires* an RFC vs. what doesn't are documented in **[docs/rfcs/README.md](docs/rfcs/README.md)**. Start from **[docs/rfcs/0000-template.md](docs/rfcs/0000-template.md)**; **[docs/rfcs/0001-example-scale-out.md](docs/rfcs/0001-example-scale-out.md)** is a worked example.

RFC outcomes are recorded as ADRs in the [decision log](docs/DECISIONS.md) so the "why" is permanent and linkable.

---

## 5. Decision-making

ICE decides by **lazy consensus**, escalating only when needed. The default is to move fast and write things down.

1. **Lazy consensus (the default).** A proposal (PR or RFC) that draws no sustained objection from the relevant area maintainers within the comment window is accepted. Silence = assent. Most changes land here.
2. **Maintainer vote.** If an area maintainer raises a substantive objection that discussion can't resolve, the maintainers vote. **A simple majority of active maintainers** carries; an area maintainer's `-1` on a change *inside their own area* is a strong (but not absolute) signal that the proposal needs more work.
3. **Steward tie-break.** A genuine deadlock is broken by the [stewards](#steward-lead-maintainer), who must record their reasoning publicly.
4. **Supermajority for the foundations.** Changes to **governance** (this file), the **architectural law** ([ADR-000](docs/DECISIONS.md)), or the **license/threat-model posture** require a **two-thirds supermajority of active maintainers**, never just a steward's call. See [Changing this document](#changing-this-document) and [§8](#8-what-cannot-change).

**Conflicts of interest.** A maintainer with a commercial or personal stake in an outcome must disclose it and recuse from the binding vote. Vendor-neutrality (§1) is enforced socially here.

**The autonomous build crew.** ICE is partly built by an autonomous agent team operating under a ratified per-release spec. Agents propose code; **a human maintainer is accountable for every merge** and for keeping the build on-thesis. Agents never hold a binding vote.

---

## 6. Stewardship: trademark, assets, and a path to a foundation

The **code** is protected by Apache-2.0 and the no-CLA structure (§3) — that can't be taken away. The **non-code assets** need a steward:

- **The "ICE" name & marks**, the project domains, the package namespaces, the social/community accounts, and the CI/infra credentials.

**Today (early stage):** these are held by the founding stewards *in trust for the project*, governed by this document. Stewards commit publicly that these assets exist to serve the community and will be transferred per the plan below — they are not the stewards' to monetise or withhold.

**The plan — a vendor-neutral foundation.** When ICE clears a maturity bar (a sustained multi-organisation maintainer base; meaningful external adoption; assets — domains, marks, accounts — worth formally protecting), the stewards will move the trademark and project assets to a **vendor-neutral non-profit foundation** (e.g. a fiscal host such as Software Freedom Conservancy / Commons Conservancy, or a dedicated entity). The foundation will:

- hold the **trademark** and publish a light **trademark-use policy** (forks may use the code freely under Apache-2.0; using the *name* "ICE" to brand a competing or modified service follows the policy, so users aren't confused about what is official);
- hold domains, namespaces, and community accounts so they survive any individual leaving;
- adopt **this governance document** (or its successor) as its operating charter;
- take **no copyright assignment** — the no-CLA structure is preserved; the foundation stewards marks and infra, not the copyright.

Until that transfer, the [guarantees in §8](#8-what-cannot-change) are the binding commitment.

---

## 7. Code of Conduct

ICE adopts the **[Contributor Covenant](https://www.contributor-covenant.org/) v2.1** as its Code of Conduct, applying to all project spaces (repo, issues, PRs, chat, voice rooms, events). The canonical text lives in `CODE_OF_CONDUCT.md` at the repo root (add it from the Covenant template if absent). Reports go to the stewards via the contact in [SECURITY.md](SECURITY.md); enforcement follows the Covenant's enforcement ladder, and the stewards act on reports confidentially.

In short: be respectful, assume good faith, and remember that a shared *live* workspace — humans and agents in the same room — only works on trust.

---

## 8. What cannot change

These are the guarantees the community can rely on. They can only be amended by the [supermajority process](#changing-this-document), and amending them to *weaken* them is itself a signal to fork:

1. **The license stays open and permissive.** ICE will not be relicensed to a non-open or source-available-but-restricted license. (The no-CLA structure makes this practically enforceable: no one holds the rights to do it unilaterally.)
2. **It stays self-hostable and air-gappable.** No mandatory phone-home, no required hosted control plane, no license key to run your own instance. ([No-phone-home is in SECURITY.md](SECURITY.md) and the [vision](docs/VISION.md).)
3. **No copyright assignment / no CLA.** Contributors keep their copyright; the project never aggregates it.
4. **The architectural law holds.** [ADR-000](docs/DECISIONS.md) — Yjs is the single source of truth; agents write through the doc — is foundational and changes only by supermajority + RFC.
5. **Stewards/foundation steward, they do not own.** No steward or future foundation may sell, close, or relicense ICE, or assert ownership over contributors' copyrights.

If a maintainer or steward ever acts against these guarantees, the community's recourse is built in: **fork it.** That right is the whole point.

---

## Changing this document

Amendments to GOVERNANCE.md follow the [RFC process](docs/rfcs/README.md) and require a **two-thirds supermajority of active maintainers**, with a minimum **two-week** final-comment period. Changes to [§8 "What cannot change"](#8-what-cannot-change) additionally require that the change *strengthen or preserve* the guarantees — a proposal to weaken them is out of order and is grounds for the community to fork. All amendments are recorded in the [decision log](docs/DECISIONS.md).

---

### See also

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute (DCO, setup, style).
- [docs/rfcs/README.md](docs/rfcs/README.md) — the RFC process.
- [docs/DECISIONS.md](docs/DECISIONS.md) — the ratified decision log (ADRs).
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — the self-hoster threat model.
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — publishing/installing community extensions.
- [SECURITY.md](SECURITY.md) — vulnerability reporting.
- [docs/VISION.md](docs/VISION.md) — what ICE is (and is NOT).

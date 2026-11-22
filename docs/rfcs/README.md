# ICE RFCs (Requests for Comments)

> Substantial changes to ICE are proposed, discussed, and recorded in the open as **RFCs**. This is how ["decide in the open"](../../GOVERNANCE.md#1-principles) works in practice: an RFC is a written, reviewable, linkable answer to *"why are we doing this, and why this way?"*

An RFC is a Markdown file in this directory. It captures a meaningful proposal — its motivation, design, alternatives, and trade-offs — so the [maintainers](../../GOVERNANCE.md#2-roles) can debate it before code is written, and so the reasoning survives long after the PR is merged.

---

## When you need an RFC (and when you don't)

**Open an RFC for anything substantial or hard to reverse:**

- a change to the **architecture** or the [architectural law (ADR-000)](../DECISIONS.md) — e.g. how Yjs/git/filesystem converge, how agents write to the doc;
- a new or changed **public contract** — a wire protocol, a shared type in `packages/shared`, an env-var surface, an extension manifest format;
- a **scale-out / infra** change with operational impact — a new backing service, a swap of the CRDT sync backend, a multi-node story;
- a change to the **threat model** or security posture ([THREAT_MODEL.md](THREAT_MODEL.md), [SECURITY.md](../../SECURITY.md));
- adopting (or declining) a **major external protocol or dependency** — e.g. the [A2A evaluation](../A2A_EVALUATION.md);
- a shift in the **roadmap thesis** or product pillars ([DECISIONS.md](../DECISIONS.md), [VISION.md](../VISION.md));
- a change to **governance itself** ([GOVERNANCE.md](../../GOVERNANCE.md) — requires a [supermajority](../../GOVERNANCE.md#5-decision-making)).

**You do _not_ need an RFC for** (just open a PR):

- bug fixes and small, obvious, reversible changes;
- internal refactors that keep public contracts stable;
- docs, tests, dependency bumps, CI tweaks;
- anything already specified by an accepted release plan in [`plans/releases/`](../../plans).

When in doubt, open a short RFC. Cheap to write, expensive to skip.

---

## The process

1. **Copy the template.** Start from [`0000-template.md`](0000-template.md).
2. **Claim a number.** Use the next free zero-padded integer (look at the highest existing `NNNN-*.md`). Name the file `NNNN-short-slug.md`. (Number collisions are resolved at review time — don't block on it.)
3. **Open a PR** that adds the RFC file, with status **`draft`**. The PR *is* the discussion thread.
4. **Discussion.** Maintainers and contributors comment. Revise in place; capture unresolved questions in the RFC's *Open questions* section. Move status to **`discussion`** once it's ready for broad review.
5. **Final comment period (FCP).** When the shepherding maintainer judges the discussion has converged, they announce an FCP (default **one week**; **two weeks** for governance/architectural-law changes) and set status **`final-comment`**. This is the last call for objections.
6. **Decision.** Decided by [lazy consensus → maintainer vote → steward tie-break](../../GOVERNANCE.md#5-decision-making); foundational changes need a [two-thirds supermajority](../../GOVERNANCE.md#8-what-cannot-change). The shepherd sets status to **`accepted`** or **`rejected`**, fills in the *Resolution* section (who decided, when, why), and merges the PR either way — **a rejected RFC stays in the tree** as a record of the path not taken.
7. **Record the decision.** An accepted RFC that changes a ratified decision is reflected as an ADR in [DECISIONS.md](../DECISIONS.md), linking back to the RFC.
8. **Implementation.** Track the work from the RFC's *Implementation* section (issues/PRs). When shipped, set status **`implemented`**.

---

## Lifecycle

```
draft ─▶ discussion ─▶ final-comment ─▶ accepted ─▶ implemented
                              │
                              └────────▶ rejected         (kept in-tree)
                                          withdrawn        (author backs out)
                                          superseded-by:NNNN
```

| Status | Meaning |
|---|---|
| `draft` | Being written; not yet ready for broad review. |
| `discussion` | Open for maintainer/community review. |
| `final-comment` | Converged; last-call window before a decision. |
| `accepted` | Approved per [decision-making](../../GOVERNANCE.md#5-decision-making). Implementation may begin. |
| `rejected` | Not adopted. The file stays as a record of the reasoning. |
| `withdrawn` | The author withdrew it. |
| `implemented` | Accepted **and** shipped. |
| `superseded-by: NNNN` | Replaced by a later RFC. |

---

## Front-matter

Every RFC begins with this header block (kept human-readable, not parsed by tooling yet):

```
- RFC: NNNN
- Title: <short title>
- Status: draft | discussion | final-comment | accepted | rejected | withdrawn | implemented | superseded-by: NNNN
- Authors: <name(s) / handle(s)>
- Area: <sync | git | agent-host | comms | web | extensions | security | governance | docs>
- Created: YYYY-MM-DD
- Decision recorded: <link to DECISIONS.md ADR, once accepted>
```

---

## Index

| RFC | Title | Status |
|---|---|---|
| [0000](0000-template.md) | RFC template | n/a (template) |
| [0001](0001-example-scale-out.md) | Horizontal scale-out for the sync server | accepted (example) |

> Keep this table updated when you add or transition an RFC.

See [GOVERNANCE.md](../../GOVERNANCE.md) for roles, decision-making, and the guarantees the RFC process protects.

- RFC: 0000
- Title: <short, descriptive title>
- Status: draft
- Authors: <your name / handle>
- Area: <sync | git | agent-host | comms | web | extensions | security | governance | docs>
- Created: YYYY-MM-DD
- Decision recorded: <link to docs/DECISIONS.md ADR, filled in once accepted>

---

# RFC 0000: <Title>

> Copy this file to `NNNN-short-slug.md`, pick the next free number, and set
> `Status: draft`. Delete these quoted instructions as you go. Keep it concise —
> an RFC is an argument, not a manual. See [the RFC process](README.md).

## Summary

One paragraph. What is this change, in plain language? If a reviewer reads only
this, they should understand *what* you propose and roughly *why*.

## Motivation

What problem does this solve? Who has it, and how do we know it's real? What
happens if we do nothing? Tie it to the [vision](../VISION.md), the
[pillars / ADRs](../DECISIONS.md), or a concrete operator/contributor pain.

## Guide-level explanation

Explain the proposal as you would to a contributor or operator who will *use*
it — concepts, names, examples, the happy path. Show the new env var / API /
manifest / UI as it would actually appear. Prefer a short example over prose.

## Reference-level explanation

The precise design. Data structures, contracts, wire formats, migration steps,
file/module boundaries (respect the [architectural law, ADR-000](../DECISIONS.md)
and the decoupling conventions). Be specific enough that someone else could
implement it. Call out where it touches `packages/shared`, the sync seam, the
git server, the agent host, or the extension surface.

## Drawbacks

Why might we *not* do this? Cost, complexity, new failure modes, operational
burden on self-hosters, surface area for security ([THREAT_MODEL.md](../THREAT_MODEL.md)).
Be honest — a drawbacks section that says "none" is a red flag.

## Alternatives

What else did you consider, and why is this better? Include "do nothing" and any
off-the-shelf option you're choosing *not* to adopt. Decisiveness here is what
makes the RFC useful later.

## Security & threat-model impact

Does this add a trust boundary, a new secret, a new way to run code, or a new
network surface? If yes, how is it mitigated? If it changes
[THREAT_MODEL.md](../THREAT_MODEL.md), say so. If it's security-neutral, state
that explicitly.

## Prior art

Links to how other projects (CRDT/IDE/agent/infra) solved this, and what we
learned from them.

## Open questions

Unresolved points to settle during discussion. It's fine to ship an RFC to
`discussion` with open questions — track them here and resolve before
`final-comment`.

## Implementation

Rough plan: the slices/PRs, who's doing it, and any sequencing or release
target. Link issues/PRs as they appear. (Filled in as it lands.)

## Resolution

> Filled in by the shepherding maintainer at decision time.

- Decided: <date>
- Outcome: <accepted | rejected | withdrawn>
- Decided by: <lazy consensus | maintainer vote N-M | steward tie-break | supermajority>
- Rationale: <one paragraph on why>
- ADR: <link to docs/DECISIONS.md entry, if any>

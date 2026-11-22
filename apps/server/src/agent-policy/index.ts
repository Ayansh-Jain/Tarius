/**
 * Agent policy + snapshot module — public API (v1.5 Slice B).
 *
 * Two coordinated guarantees for "a squad of agents" sharing ONE repo:
 *
 *   1. PER-AGENT PERMISSIONS + PROPOSE-THEN-APPLY (./policy.ts). A pure decision
 *      layer over @ice/shared `AgentPolicy`: deny-precedence tool/path checks and
 *      an `enforce()` hook the agent host runs before every tool call. Destructive
 *      ops that the policy guards are forced through the v0.5 approval gate
 *      (propose-then-apply), not silently applied.
 *
 *   2. OPT-IN SNAPSHOTS (./snapshot.ts). The escape hatch: an agent can fork a
 *      branch off the room's HEAD via the v0.3 convergence/git layer, work there,
 *      and then merge the result back (or discard it). Isolation as an *option*,
 *      never the default (ADR-004 keeps the shared-repo bet intact).
 *
 * ── WIRING (the driver does this in the v0.1-owned files; nothing here edits them) ──
 *
 * A) Construct the registry + share the snapshot store at boot (e.g. in index.ts):
 *
 *      import { PolicyRegistry, snapshotStore } from './agent-policy/index.js';
 *      const policies = new PolicyRegistry();
 *
 * B) Inject the policy check into the agent host's tool path. The host already
 *    funnels every proposed tool call through one place before applying it
 *    (adapter/host). Wrap that call site so the policy decides first:
 *
 *      import { enforce, type PolicyCall } from './agent-policy/index.js';
 *
 *      const call: PolicyCall = {
 *        tool: toolName,
 *        path: fileOp?.path,              // present for fs writes/deletes
 *        destructive: isDestructive(op),  // delete / run-command / force-push …
 *      };
 *      const decision = enforce(policies.get(roomId, agentId), call);
 *      if (decision.effect === 'deny') {
 *        // emit a rejected/error tool-call event the agent sees; do NOT apply.
 *      } else if (decision.effect === 'require-approval') {
 *        // record the AgentToolCall with requiresApproval=true and park it on the
 *        // existing v0.5 gate; resolveApproval(roomId, callId, 'approve') applies.
 *      } else {
 *        // effect === 'allow' → execute immediately as today.
 *      }
 *
 *    The host can also hold the registry directly and call
 *    `policies.enforce(roomId, agentId, call)` for the same result.
 *
 * C) HTTP routes (mounted by the driver in api.ts), thin wrappers over this API:
 *
 *      // set/replace a per-agent policy
 *      PUT  /api/rooms/:roomId/agents/:agentId/policy
 *        → policies.set(roomId, { agentId, ...body })   // body: AgentPolicy fields
 *      GET  /api/rooms/:roomId/agents/:agentId/policy
 *        → policies.get(roomId, agentId)
 *
 *      // snapshots ("try it safely")
 *      POST   /api/rooms/:roomId/snapshots
 *        → await createAgentSnapshot(roomId, doc, body.agentId, { message })
 *      POST   /api/rooms/:roomId/snapshots/:snapshotId/commit   // optional: land agent work on the branch
 *        → await commitSnapshotFiles(snapshotId, body.files, { message })
 *      POST   /api/rooms/:roomId/snapshots/:snapshotId/merge
 *        → await mergeSnapshot(snapshotId)            // then re-run loadRoomFromGit(roomId, doc)
 *      POST   /api/rooms/:roomId/snapshots/:snapshotId/discard
 *        → await discardSnapshot(snapshotId)
 *      GET    /api/rooms/:roomId/snapshots
 *        → snapshotStore.list(roomId)
 *
 *    `doc` is the room's live Y.Doc the driver already has from Hocuspocus. After
 *    a merge, the driver should reload the doc from git so clients see the work:
 *    `await loadRoomFromGit(roomId, doc)` (convergence module). Guard every route
 *    with the existing auth/roles middleware (writers may snapshot/merge).
 */

// ── Policy engine ───────────────────────────────────────────────────────────────
export {
  checkToolAllowed,
  checkWriteAllowed,
  enforce,
  requiresHumanGate,
  makePolicy,
  PolicyRegistry,
  PERMISSIVE_POLICY,
} from './policy.js';
export type { PolicyCall, PolicyDecision, PolicyDenyReason } from './policy.js';

// ── Opt-in snapshots ────────────────────────────────────────────────────────────
export {
  createAgentSnapshot,
  commitSnapshotFiles,
  mergeSnapshot,
  discardSnapshot,
  snapshotBranchName,
  snapshotStore,
  SnapshotStore,
} from './snapshot.js';
export type {
  SnapshotFile,
  CreateSnapshotOptions,
  MergeSnapshotResult,
} from './snapshot.js';

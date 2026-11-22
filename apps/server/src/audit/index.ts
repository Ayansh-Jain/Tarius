/**
 * Audit log — public API (v2.0 Slice A).
 *
 * The accountable "who did what" trail for a room, stored on the room Y.Doc as a
 * capped, multiplayer `Y.Array<AuditEntry>` (see {@link recordAudit}) and read
 * back live or over HTTP ({@link readAudit} / {@link makeAuditRoutes}).
 *
 * ── DRIVER WIRING — the HTTP route (apps/server/src/api.ts) ───────────────────
 *   import { makeAuditRoutes } from './audit/index.js';
 *   import { getRoomDoc } from './room-doc.js';
 *   app.route('/', makeAuditRoutes({ resolveDoc: getRoomDoc }));
 *
 * ── DRIVER WIRING — where to call recordAudit ────────────────────────────────
 * Call `recordAudit(doc, roomId, { actor, action, detail })` at these sites so
 * the trail captures every consequential action. `doc` is the room's live
 * Y.Doc; `roomId` the room. Suggested actor/action/detail per site:
 *
 *   1. AGENT FILE EDIT — agent/host.ts, right after an agent's origin-tagged
 *      `{kind:'agent', agentId}` edit transaction commits.
 *        actor:  { kind:'agent', id: agentId, name: agentName }
 *        action: 'edit'
 *        detail: the file path (e.g. 'src/app.ts')
 *
 *   2. TOOL CALL — agent/host.ts (or agent/approval.ts), when a (possibly gated)
 *      tool call is APPLIED.
 *        actor:  { kind:'agent', id: agentId, name: agentName }
 *        action: 'tool-call'
 *        detail: the tool name (+ short args), e.g. 'shell: pnpm test'
 *
 *   3. COMMIT — convergence/index.ts `flushAndCommit`, after a successful commit.
 *        actor:  the committer — { kind:'human'|'agent'|'system', id, name }
 *        action: 'commit'
 *        detail: `${shortHash} ${message}`
 *
 *   4. SNAPSHOT MERGE — agent-policy/index.ts `mergeSnapshot`, after a snapshot
 *      branch is merged back to the room's main.
 *        actor:  { kind:'agent', id: agentId, name: agentName }
 *        action: 'snapshot-merge'
 *        detail: `${snapshotId} -> main (${mergedHash})`
 *
 *   5. ORCHESTRATE — orchestrator/index.ts `startOrchestration`, when a squad run
 *      is launched (and again on interrupt with action 'orchestrate-interrupt').
 *        actor:  { kind:'human', id: requesterId, name } (who asked) — or system
 *        action: 'orchestrate'
 *        detail: a short prompt/plan summary
 *
 * These call sites live in v1.5-owned files this slice MUST NOT edit, so the
 * driver adds the one-line `recordAudit(...)` at each. Everything else (the
 * recorder, cap, route) is self-contained here.
 */
export {
  recordAudit,
  readAudit,
  DEFAULT_AUDIT_CAP,
} from './recorder.js';
export type {
  RecordAuditInput,
  RecordAuditOptions,
  ReadAuditOptions,
} from './recorder.js';

export { makeAuditRoutes } from './routes.js';
export type { AuditRoutesDeps, AuditDocResolver } from './routes.js';

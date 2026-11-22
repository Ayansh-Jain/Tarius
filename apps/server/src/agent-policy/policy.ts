/**
 * Per-agent permission engine (v1.5 Slice B) — the policy half of "a squad of
 * agents". With many agents co-editing ONE shared repo (ADR-004: agents act
 * THROUGH the doc), "what may this particular agent do?" stops being academic.
 *
 * This module is a pure decision layer over {@link AgentPolicy} (@ice/shared):
 *   • {@link checkToolAllowed}  — may agent call `toolName`?
 *   • {@link checkWriteAllowed} — may agent write `path`?
 *   • {@link enforce}           — combine both for a concrete tool call, and
 *                                 decide whether the v0.5 approval gate must fire
 *                                 (propose-then-apply for destructive ops).
 *   • {@link PolicyRegistry}    — per-room, per-agent set/get of policies.
 *
 * THE RULES (small, predictable, deny-biased — a permission system that
 * surprises you is a security bug):
 *   1. DENY PRECEDENCE. A match in `denyTools`/`denyPaths` always loses to allow,
 *      even against `['*']`. The safe answer wins ties.
 *   2. `['*']` in `allowTools` means "all tools". An empty `writePaths` means
 *      "all paths" (writes aren't path-scoped unless you opt in) — but `denyPaths`
 *      still subtracts from that universe.
 *   3. PATH-PREFIX SCOPING. Allow/deny path entries match by normalized path
 *      prefix at a segment boundary, so `src` guards `src/a.ts` but never the
 *      sibling `src-gen/x.ts`.
 *   4. requireApprovalForDestructive FORCES THE GATE. A permitted-but-destructive
 *      call is allowed *to be proposed*, but must pass the human approval gate
 *      before it applies (propose-then-apply). This reuses v0.5 approval-gate
 *      semantics: the host records the call as pending and a human approves it.
 *
 * Pure + dependency-light on purpose: the agent host injects {@link enforce} into
 * its tool path (see this slice's wiringInstructions); nothing here imports the
 * host, the doc, or the filesystem.
 */
import type { AgentPolicy } from '@ice/shared';

/** The canonical "anything goes" policy — handy as a default for un-set agents. */
export const PERMISSIVE_POLICY: Omit<AgentPolicy, 'agentId'> = {
  allowTools: ['*'],
  denyTools: [],
  writePaths: [],
  denyPaths: [],
  requireApprovalForDestructive: true,
};

/** Build a full {@link AgentPolicy} for `agentId`, permissive except where overridden. */
export function makePolicy(agentId: string, overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return { agentId, ...PERMISSIVE_POLICY, ...overrides };
}

/**
 * A normalized tool call the engine reasons about. The agent host already builds
 * an AgentToolCall for the doc; this is the slimmer view the policy needs, plus
 * the optional `path` (file ops) and an explicit `destructive` flag the host
 * derives from the tool/op kind (delete, run-command, force-push, …).
 */
export interface PolicyCall {
  /** Tool name, e.g. 'fs/write', 'fs/delete', 'run-command'. */
  tool: string;
  /** Target path for file ops; omitted for non-file tools. */
  path?: string;
  /** True for large/irreversible ops (delete, shell, force-push, …). */
  destructive?: boolean;
}

/** Why a call was blocked — surfaced to the UI / agent so the reason is legible. */
export type PolicyDenyReason =
  | 'tool-denied'
  | 'tool-not-allowed'
  | 'write-denied'
  | 'write-not-allowed';

/** The outcome of {@link enforce}: allow outright, require approval, or block. */
export type PolicyDecision =
  | { effect: 'allow' }
  | { effect: 'require-approval'; reason: 'destructive' }
  | { effect: 'deny'; reason: PolicyDenyReason; detail: string };

// ── tool checks ────────────────────────────────────────────────────────────────

/**
 * May `policy` call `toolName`? Deny precedence: an exact match in `denyTools`
 * always wins. Otherwise allowed iff `allowTools` is `['*']` or lists the tool
 * exactly. Tool names are matched literally (no globbing beyond the `*`
 * wildcard) — predictability beats cleverness for a permission check.
 */
export function checkToolAllowed(policy: AgentPolicy, toolName: string): boolean {
  if (policy.denyTools.includes(toolName)) return false; // rule 1: deny wins
  if (policy.allowTools.includes('*')) return true; // rule 2: wildcard
  return policy.allowTools.includes(toolName);
}

// ── write-path checks ────────────────────────────────────────────────────────

/**
 * May `policy` write `path`? Deny precedence again: if any `denyPaths` entry is a
 * prefix of `path` (at a segment boundary), it's blocked — even if `writePaths`
 * also matches (rule 1 + rule 3 worked example: writePaths=['src'],
 * denyPaths=['src/secrets'] → 'src/secrets/key.ts' is DENIED). Otherwise allowed
 * iff `writePaths` is empty (no scoping) or some entry is a prefix of `path`.
 *
 * Paths are normalized (leading `./`, duplicate slashes, and a single trailing
 * slash are ignored) before comparison so policy authors needn't be pedantic.
 */
export function checkWriteAllowed(policy: AgentPolicy, path: string): boolean {
  const target = normalize(path);
  // rule 1: any deny-prefix match blocks, beating writePaths.
  for (const deny of policy.denyPaths) {
    if (isPrefixPath(normalize(deny), target)) return false;
  }
  // rule 2: empty writePaths = unscoped (everything not denied is allowed).
  if (policy.writePaths.length === 0) return true;
  // rule 3: otherwise the target must fall under an allowed prefix.
  for (const allow of policy.writePaths) {
    if (isPrefixPath(normalize(allow), target)) return true;
  }
  return false;
}

// ── combined enforcement (the host's hook) ─────────────────────────────────────

/**
 * The single decision the agent host runs BEFORE applying a tool call. Order:
 *   1. tool gate — blocked tool → deny.
 *   2. write gate — file op outside the writable set → deny.
 *   3. propose-then-apply — a permitted *destructive* op when the policy demands
 *      approval → require-approval (the host parks it on the v0.5 approval gate).
 *   4. otherwise → allow.
 *
 * The host maps `require-approval` onto the existing gate (record the
 * AgentToolCall with requiresApproval=true and wait for resolveApproval); `deny`
 * onto a rejected/error tool-call event the agent sees; `allow` onto immediate
 * execution. This function performs no side effects.
 */
export function enforce(policy: AgentPolicy, call: PolicyCall): PolicyDecision {
  // 1. tool gate.
  if (policy.denyTools.includes(call.tool)) {
    return { effect: 'deny', reason: 'tool-denied', detail: `tool '${call.tool}' is denied by policy` };
  }
  if (!checkToolAllowed(policy, call.tool)) {
    return {
      effect: 'deny',
      reason: 'tool-not-allowed',
      detail: `tool '${call.tool}' is not in the allow-list`,
    };
  }

  // 2. write gate (only meaningful for file ops that carry a path).
  if (call.path !== undefined) {
    if (anyDenyMatches(policy, call.path)) {
      return {
        effect: 'deny',
        reason: 'write-denied',
        detail: `path '${call.path}' is denied by policy`,
      };
    }
    if (!checkWriteAllowed(policy, call.path)) {
      return {
        effect: 'deny',
        reason: 'write-not-allowed',
        detail: `path '${call.path}' is outside the writable paths`,
      };
    }
  }

  // 3. propose-then-apply: permitted but destructive → force the approval gate.
  if (call.destructive && policy.requireApprovalForDestructive) {
    return { effect: 'require-approval', reason: 'destructive' };
  }

  // 4. clean pass.
  return { effect: 'allow' };
}

/**
 * Does enforcement require a human approval (or outright deny) for `call`? A
 * convenience for the host: returns true when the call must NOT execute
 * immediately. `allow` → false; `require-approval`/`deny` → true.
 */
export function requiresHumanGate(policy: AgentPolicy, call: PolicyCall): boolean {
  return enforce(policy, call).effect !== 'allow';
}

// ── registry ───────────────────────────────────────────────────────────────────

/**
 * Per-room, per-agent policy store. The driver owns one instance and the host
 * consults it on every tool call (via {@link enforce}). Unset agents fall back to
 * {@link makePolicy} (permissive-but-gated) so a freshly-spawned agent is safe by
 * default rather than unbounded.
 */
export class PolicyRegistry {
  /** roomId -> agentId -> policy. */
  private readonly byRoom = new Map<string, Map<string, AgentPolicy>>();

  /** Set (or replace) the policy for an agent in a room. */
  set(roomId: string, policy: AgentPolicy): void {
    let room = this.byRoom.get(roomId);
    if (!room) {
      room = new Map();
      this.byRoom.set(roomId, room);
    }
    room.set(policy.agentId, policy);
  }

  /**
   * Get the agent's policy, or a default permissive-but-gated policy if none was
   * set. Never returns undefined: the host always has a policy to enforce.
   */
  get(roomId: string, agentId: string): AgentPolicy {
    return this.byRoom.get(roomId)?.get(agentId) ?? makePolicy(agentId);
  }

  /** Has an explicit policy been set for this agent? (vs. the default). */
  has(roomId: string, agentId: string): boolean {
    return this.byRoom.get(roomId)?.has(agentId) ?? false;
  }

  /** All explicitly-set policies in a room (for an admin/settings view). */
  list(roomId: string): AgentPolicy[] {
    return [...(this.byRoom.get(roomId)?.values() ?? [])];
  }

  /** Drop an agent's policy (e.g. when it stops). Idempotent. */
  delete(roomId: string, agentId: string): void {
    this.byRoom.get(roomId)?.delete(agentId);
  }

  /** Enforce `call` for (room, agent) using the stored-or-default policy. */
  enforce(roomId: string, agentId: string, call: PolicyCall): PolicyDecision {
    return enforce(this.get(roomId, agentId), call);
  }
}

// ── path helpers (kept local + explicit; no node:path import churn) ─────────────

/**
 * Normalize a repo-relative POSIX path for comparison: strip a leading `./`,
 * collapse duplicate slashes, and drop a single trailing slash. We deliberately
 * do NOT resolve `..` here — policy entries are author-controlled, and the
 * convergence layer already rejects traversal when paths hit disk.
 */
function normalize(p: string): string {
  let s = p.trim();
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Is `prefix` a path-prefix of `target` at a segment boundary? `''` matches
 * everything (an empty/`.` scope means "the whole tree"); otherwise `target`
 * must equal `prefix` or start with `prefix + '/'`. This is what stops `src`
 * from matching the sibling directory `src-gen`.
 */
function isPrefixPath(prefix: string, target: string): boolean {
  if (prefix === '' || prefix === '.') return true;
  if (target === prefix) return true;
  return target.startsWith(`${prefix}/`);
}

/** True if any denyPaths entry is a prefix of `path`. */
function anyDenyMatches(policy: AgentPolicy, path: string): boolean {
  const target = normalize(path);
  return policy.denyPaths.some((deny) => isPrefixPath(normalize(deny), target));
}

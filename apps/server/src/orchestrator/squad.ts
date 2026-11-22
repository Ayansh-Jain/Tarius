/**
 * The host-backed {@link AgentSquad} (v1.5) — the orchestrator's bridge to the
 * v0.5 agent host.
 *
 * This is the ONE place the orchestrator's abstract "spawn / assign / interrupt /
 * stop a specialist" verbs become real agents. Each specialist is a distinct
 * agent on the SAME room doc, with its own `agentId` and therefore its own
 * `{kind:'agent', agentId}` Yjs origin — so when several run at once their edits
 * are independently attributable and, because each is pinned to a DIFFERENT
 * target file, conflict-free by construction.
 *
 * Crucially this module stays decoupled from the host's concrete singleton: it
 * depends on the small {@link HostLike} surface (the subset of the agent host it
 * uses). The driver injects the real host (`getAgentHost()` / the module-level
 * fns) and CI/tests inject a fresh `AgentHost` instance — same code path, no
 * process or network.
 *
 * Per-specialist work is scripted through the existing {@link MockAgentBackend}:
 * we point each agent's backend at the subtask's `targetFile`, then a single
 * `handleAgentMessage` drives one attributable append to that file. The squad
 * factory wires a `backendFactory` that injects per-agent `MockAgentOptions`, so
 * the orchestrator never has to know mock internals.
 */
import type * as Y from 'yjs';
import {
  MockAgentBackend,
  type AgentBackendFactory,
} from '../agent/index.js';
import type {
  AgentConfig,
  AgentId,
  RoomId,
  Subtask,
} from '@ice/shared';
import type {
  AgentSpawnSpec,
  AgentSquad,
  SquadFactory,
} from './types.js';

/**
 * The subset of the v0.5 agent host this squad needs. Both the module-level
 * functions (driver) and an `AgentHost` instance (tests) satisfy it, so we never
 * couple to the singleton.
 */
export interface HostLike {
  startAgentForRoom(
    roomId: RoomId,
    doc: Y.Doc,
    config: AgentConfig,
    deps?: { backendFactory?: AgentBackendFactory },
  ): Promise<unknown>;
  handleAgentMessage(
    roomId: RoomId,
    doc: Y.Doc,
    text: string,
    opts?: { agentId?: AgentId },
  ): Promise<void>;
  interruptAgent(roomId: RoomId, agentId?: AgentId): boolean;
  stopAgent(roomId: RoomId, agentId: AgentId): Promise<void>;
}

/** A squad that drives specialists through a {@link HostLike} agent host. */
export class HostBackedSquad implements AgentSquad {
  /** Per-agent target file, so `assign` knows nothing-but-the-id is enough. */
  private readonly targets = new Map<AgentId, string>();

  constructor(
    private readonly host: HostLike,
    private readonly roomId: RoomId,
    private readonly doc: Y.Doc,
  ) {}

  async spawn(spec: AgentSpawnSpec): Promise<void> {
    this.targets.set(spec.agentId, spec.targetFile);

    const config: AgentConfig = {
      agentId: spec.agentId,
      kind: 'mock',
      displayName: spec.displayName,
    };

    // Inject a backend factory that pins THIS agent's mock to THIS agent's file,
    // so a routed turn appends to a file no other specialist touches. The mock's
    // gated delete/run targets per-agent scratch paths too, so concurrent gates
    // never collide. We keep the factory closed over the spec (not shared) so
    // each spawned agent is independently configured.
    const role = spec.role;
    const backendFactory: AgentBackendFactory = (config, sink, deps) =>
      new MockAgentBackend(config, sink, deps, {
        targetFile: spec.targetFile,
        destructiveTarget: `.ice/scratch/${spec.agentId}.tmp`,
        safeCommand: `echo "${role} ${spec.agentId} done"`,
        snippetTemplate: snippetFor(role),
      });

    await this.host.startAgentForRoom(this.roomId, this.doc, config, { backendFactory });
  }

  async assign(agentId: AgentId, _subtask: Subtask): Promise<void> {
    const target = this.targets.get(agentId);
    const prompt = _subtask.description || `Work on ${target ?? 'your file'}`;
    // One scripted turn → one attributable append to the agent's target file.
    await this.host.handleAgentMessage(this.roomId, this.doc, prompt, { agentId });
  }

  interrupt(agentId: AgentId): void {
    this.host.interruptAgent(this.roomId, agentId);
  }

  async stop(agentId: AgentId): Promise<void> {
    this.targets.delete(agentId);
    await this.host.stopAgent(this.roomId, agentId);
  }
}

/**
 * Build a {@link SquadFactory} over a host. The driver passes the module-level
 * agent-host functions (or `getAgentHost()` bound); tests pass a fresh
 * `AgentHost` instance. Either way the orchestrator just gets an `AgentSquad`.
 */
export function makeHostSquad(host: HostLike): SquadFactory {
  return (roomId, doc) => new HostBackedSquad(host, roomId, doc);
}

/**
 * Role-flavored snippet the mock appends, so each specialist's contribution
 * reads distinctly in the file (and so a human reviewing the doc can see which
 * agent wrote what). `{{n}}` is the mock's per-turn index.
 */
function snippetFor(role: string): string {
  switch (role) {
    case 'architect':
      return `\n// [architect] design note {{n}}\n// - shape the module boundaries\n`;
    case 'coder':
      return (
        `\nexport function feature{{n}}(): string {\n` +
        `  // implemented by the coder agent\n` +
        `  return 'feature {{n}}';\n` +
        `}\n`
      );
    case 'debugger':
      return `\n// [debugger] repro {{n}}: traced + guarded the failing path\n`;
    case 'reviewer':
      return (
        `\n// [reviewer] review {{n}}: LGTM with a test\n` +
        `export const reviewed{{n}} = true;\n`
      );
    default:
      return `\n// [{{n}}] contribution by ${role}\n`;
  }
}

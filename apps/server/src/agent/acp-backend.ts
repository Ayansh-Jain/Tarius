/**
 * AcpAgentBackend (v0.5 Slice A) — a REAL agent over the Agent Client Protocol.
 *
 * Spawns an ACP-compatible agent binary (claude-code / codex / gemini) as a
 * child process and speaks ACP over its stdio using
 * {@link ClientSideConnection}. We are the *Client*; the child is the *Agent*.
 * BYO-key: the command + env (e.g. ANTHROPIC_API_KEY) come from the environment.
 *
 * THE BOUNDARY: this backend never writes the doc or the filesystem. It maps the
 * ACP surface onto adapter intents:
 *   • fs/read_text_file  → sink.readFile(path)         (the live doc, not disk)
 *   • fs/write_text_file → file 'write' effect (applied via the adapter)
 *   • session/update tool_call (kind 'edit')           → 'edit'/file effects
 *   • session/update agent_message_chunk               → chat message
 *   • session/request_permission                       → THE APPROVAL GATE
 *
 * Permission requests are ACP *blocking requests*: the agent waits for our
 * decision. We surface the gate (status 'awaiting-approval' + a pending call on
 * the doc) and park the request until a human resolves it via the host's
 * resolveApproval, then answer ACP with the chosen option.
 *
 * Guarded: if no command is configured, or the spawn fails, `start()` rejects
 * with a clear, actionable error. It is code-complete but NOT runtime-tested in
 * CI here (no binary / key available) — the mock backend covers the CI path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@zed-industries/agent-client-protocol';
import type { AgentConfig, AgentToolCall } from '@ice/shared';
import type { AgentBackend, AgentIntentSink, ResolvedHostDeps } from './types.js';
import type { AgentFileOp, AgentToolEffect } from './adapter.js';

/** Where the ACP child command + args come from, per backend kind. */
export interface AcpSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Resolve the spawn spec for a config from the environment. Returns null when no
 * command can be determined, so the host can fall back to the mock or surface a
 * clear error rather than crashing.
 *
 * Resolution order:
 *   1. ICE_AGENT_CMD (+ ICE_AGENT_ARGS, space-split) — an explicit override.
 *   2. A per-kind default command name on PATH (claude-code-acp, codex, gemini).
 */
export function resolveAcpSpawn(
  config: AgentConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AcpSpawnSpec | null {
  const override = env.ICE_AGENT_CMD?.trim();
  if (override) {
    const args = (env.ICE_AGENT_ARGS ?? '').trim();
    return {
      command: override,
      args: args ? args.split(/\s+/) : [],
      env,
      cwd,
    };
  }

  const byKind: Record<string, string | undefined> = {
    'claude-code': 'claude-code-acp',
    codex: 'codex-acp',
    gemini: 'gemini',
  };
  const command = byKind[config.kind];
  if (!command) return null;
  // Gemini CLI speaks ACP only when started with --acp.
  const args = config.kind === 'gemini' ? ['--acp'] : [];
  return { command, args, env, cwd };
}

export class AcpAgentBackend implements AgentBackend {
  readonly config: AgentConfig;
  private readonly sink: AgentIntentSink;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;

  /** Parked permission requests, keyed by the tool call id we surfaced. */
  private readonly gates = new Map<
    string,
    {
      resolve: (res: RequestPermissionResponse) => void;
      approveOptionId: string;
      rejectOptionId: string;
    }
  >();

  constructor(
    config: AgentConfig,
    sink: AgentIntentSink,
    _deps: ResolvedHostDeps,
    private readonly opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.config = config;
    this.sink = sink;
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
  }

  async start(): Promise<void> {
    const spec = resolveAcpSpawn(this.config, this.cwd, this.env);
    if (!spec) {
      throw new Error(
        `No ACP command for agent kind '${this.config.kind}'. Set ICE_AGENT_CMD to the ` +
          `agent binary (and ICE_AGENT_ARGS if needed), or use the 'mock' backend.`,
      );
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // npm-installed CLIs are .cmd shims on Windows, which need a shell to launch.
        shell: process.platform === 'win32',
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn ACP agent '${spec.command}': ${String((err as Error)?.message ?? err)}`,
      );
    }
    this.child = child;

    // A child that dies early (missing binary, immediate crash, EPIPE on stdin)
    // must make the handshake fail FAST rather than hang forever awaiting a
    // response that will never come. We expose that as a rejected promise we race
    // the handshake against.
    let onEarlyDeath!: (err: Error) => void;
    const earlyDeath = new Promise<never>((_, reject) => {
      onEarlyDeath = reject;
    });
    // Don't let an unhandled rejection escape if the handshake wins the race.
    earlyDeath.catch(() => {});

    // A spawn that fails asynchronously (ENOENT) surfaces on 'error'. Translate
    // it into a backend error event so the room sees a clear message, and trip
    // the early-death signal.
    child.on('error', (err) => {
      this.sink.emit({
        type: 'error',
        agentId: this.config.agentId,
        message: `ACP agent process error: ${err.message}`,
      });
      onEarlyDeath(new Error(`ACP agent process error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      if (code && code !== 0) {
        this.sink.emit({
          type: 'error',
          agentId: this.config.agentId,
          message: `ACP agent exited (code ${code}${signal ? `, ${signal}` : ''}).`,
        });
      }
      onEarlyDeath(new Error(`ACP agent exited before handshake (code ${code ?? 'null'}).`));
    });
    // stdin can throw EPIPE if the child is gone; swallow it so it doesn't crash
    // the process (the death is already handled via 'error'/'exit').
    child.stdin.on('error', () => {});
    // Surface the agent's stderr as error breadcrumbs (often auth/config hints).
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const msg = chunk.trim();
      if (msg) {
        this.sink.emit({ type: 'error', agentId: this.config.agentId, message: msg });
      }
    });

    // Bridge Node stdio <-> Web streams for ndJsonStream. We WRITE to the child's
    // stdin and READ from its stdout.
    const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(toAgent, fromAgent);

    const client: Client = this.buildClient();
    this.conn = new ClientSideConnection(() => client, stream);

    // Handshake: negotiate version + advertise our capabilities (we serve file
    // read/write so the agent edits THROUGH us, never the disk directly). Raced
    // against early child death so a missing binary rejects promptly.
    await Promise.race([
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }),
      earlyDeath,
    ]);

    const session = await Promise.race([
      this.conn.newSession({ cwd: this.cwd, mcpServers: [] }),
      earlyDeath,
    ]);
    this.sessionId = session.sessionId;

    // Optional model hint (UNSTABLE in ACP; ignore failures).
    if (this.config.model) {
      try {
        await this.conn.setSessionModel({
          sessionId: this.sessionId,
          modelId: this.config.model,
        });
      } catch {
        /* model selection is best-effort */
      }
    }

    this.sink.emit({ type: 'status', agentId: this.config.agentId, status: 'idle' });
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.conn || !this.sessionId) {
      throw new Error('AcpAgentBackend.sendUserMessage before start()');
    }
    const agentId = this.config.agentId;
    this.sink.emit({ type: 'status', agentId, status: 'thinking' });
    try {
      await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
    } catch (err) {
      this.sink.emit({
        type: 'error',
        agentId,
        message: `prompt failed: ${String((err as Error)?.message ?? err)}`,
      });
      return;
    }
    // The turn is done when prompt() resolves; status returns to idle unless a
    // gate is still open.
    if (this.gates.size === 0) {
      this.sink.emit({ type: 'status', agentId, status: 'idle' });
    }
  }

  /**
   * A human resolved a gated tool call. Answer the parked ACP permission request
   * with the chosen option so the agent continues (approve) or skips (reject).
   */
  resolveApproval(callId: string, decision: 'approve' | 'reject'): void {
    const gate = this.gates.get(callId);
    if (!gate) return;
    this.gates.delete(callId);
    gate.resolve({
      outcome: {
        outcome: 'selected',
        optionId: decision === 'approve' ? gate.approveOptionId : gate.rejectOptionId,
      },
    });
  }

  interrupt(): void {
    // Cancel the current ACP turn, and release any parked permission gates as
    // cancelled so the agent unblocks.
    for (const [, gate] of this.gates) {
      gate.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.gates.clear();
    if (this.conn && this.sessionId) {
      void this.conn.cancel({ sessionId: this.sessionId }).catch(() => {
        /* best-effort */
      });
    }
    this.sink.emit({ type: 'status', agentId: this.config.agentId, status: 'idle' });
  }

  async stop(): Promise<void> {
    this.interrupt();
    const child = this.child;
    this.child = null;
    this.conn = null;
    this.sessionId = null;
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  // ── ACP Client implementation: agent → us → adapter intents ─────────────────

  private buildClient(): Client {
    const agentId = this.config.agentId;
    return {
      // The agent streams its activity here.
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = contentText(update.content);
            if (text) {
              this.sink.emit({
                type: 'message',
                message: {
                  id: `msg_${rand()}`,
                  agentId,
                  role: 'agent',
                  text,
                  createdAt: Date.now(),
                },
              });
            }
            break;
          }
          case 'agent_thought_chunk':
            this.sink.emit({ type: 'status', agentId, status: 'thinking' });
            break;
          case 'tool_call': {
            // A tool call the agent reports. If it carries file edit locations
            // we surface an 'edit' breadcrumb; permission (if any) arrives via
            // requestPermission separately.
            this.sink.emit({
              type: 'tool-call',
              call: {
                id: update.toolCallId,
                agentId,
                tool: update.title,
                args: update.rawInput ?? {},
                requiresApproval: false,
                status: mapToolStatus(update.status),
              },
            });
            for (const loc of update.locations ?? []) {
              if (loc?.path) this.sink.emit({ type: 'edit', agentId, path: loc.path });
            }
            break;
          }
          case 'tool_call_update': {
            for (const loc of update.locations ?? []) {
              if (loc?.path) this.sink.emit({ type: 'edit', agentId, path: loc.path });
            }
            break;
          }
          default:
            break;
        }
      },

      // THE APPROVAL GATE. The agent is blocked until we answer. Surface a
      // pending tool call + 'awaiting-approval', then park the resolver.
      requestPermission: (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const tc = params.toolCall;
        const callId =
          (tc.toolCallId as string | undefined) ?? `gate_${rand()}`;
        const approveOptionId = pickOption(params, ['allow_once', 'allow_always']);
        const rejectOptionId = pickOption(params, ['reject_once', 'reject_always']);

        const call: AgentToolCall = {
          id: callId,
          agentId,
          tool: tc.title ?? 'tool',
          args: tc.rawInput ?? {},
          requiresApproval: true,
          status: 'proposed',
        };
        this.sink.emit({ type: 'tool-call', call });
        this.sink.emit({ type: 'awaiting-approval', call });

        return new Promise<RequestPermissionResponse>((resolve) => {
          this.gates.set(callId, { resolve, approveOptionId, rejectOptionId });
        });
      },

      // fs/read → the LIVE doc (never disk). Honors the requested line window.
      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        const full = this.sink.readFile(params.path);
        const content = sliceLines(full, params.line ?? null, params.limit ?? null);
        return { content };
      },

      // fs/write → a file 'write' effect applied THROUGH the adapter to the doc.
      writeTextFile: async (
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        const op: AgentFileOp = { kind: 'write', path: params.path, content: params.content };
        const effectId = `write_${rand()}`;
        const effect: AgentToolEffect = { kind: 'file', op };
        this.sink.registerEffect(effectId, effect);
        // A direct fs write is not gated (the agent already decided); apply it as
        // a non-approval tool call so the adapter mutates the doc.
        this.sink.emit({
          type: 'tool-call',
          call: {
            id: effectId,
            agentId,
            tool: 'write_file',
            args: { path: params.path },
            requiresApproval: false,
            status: 'proposed',
          },
        });
        this.sink.emit({ type: 'edit', agentId, path: params.path });
        return {};
      },
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** First option whose kind is in `prefer`, else the first option. */
function pickOption(req: RequestPermissionRequest, prefer: string[]): string {
  for (const k of prefer) {
    const found = req.options.find((o) => o.kind === k);
    if (found) return found.optionId;
  }
  return req.options[0]?.optionId ?? '';
}

/** Extract plain text from an ACP ContentBlock (only 'text' carries prose). */
function contentText(block: { type: string; text?: string }): string {
  return block.type === 'text' ? (block.text ?? '') : '';
}

function mapToolStatus(
  s: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined,
): AgentToolCall['status'] {
  switch (s) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'proposed';
  }
}

/** Return a 1-based line window [line, line+limit) of `text`, else all of it. */
function sliceLines(text: string, line: number | null, limit: number | null): string {
  if (line == null && limit == null) return text;
  const lines = text.split('\n');
  const start = line != null && line > 0 ? line - 1 : 0;
  const end = limit != null && limit > 0 ? start + limit : lines.length;
  return lines.slice(start, end).join('\n');
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

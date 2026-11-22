/**
 * Planners (v1.5) — prompt → subtasks routed to specialist roles.
 *
 * Two implementations share the {@link Planner} seam:
 *   • {@link MockPlanner} — deterministic, dependency-free. Given any prompt it
 *     yields a fixed ~3-subtask plan across DISTINCT roles, each pinned to a
 *     DIFFERENT target file. This determinism is what makes the squad's behavior
 *     assertable, and the distinct files are what make the agents' concurrent
 *     edits conflict-free by construction (different files → different Y.Text →
 *     no overlap, every edit attributable to its own agent origin).
 *   • {@link LlmPlanner} — a BYO-key sketch: it shows the exact shape a real
 *     LLM-routed planner takes (a chat-completion call returning structured
 *     subtasks), with a hard, typed fallback to the mock plan when no key/client
 *     is configured, so the system degrades gracefully in CI.
 */
import type { AgentRole } from '@ice/shared';
import type { PlannedSubtask, Planner, PlannerContext } from './types.js';

/**
 * Deterministic planner used for tests/CI and whenever no LLM key is set.
 *
 * The plan is intentionally a small, realistic squad pipeline:
 *   architect → lays out a design note,
 *   coder     → implements the feature,
 *   reviewer  → adds review notes / a test stub.
 * Each subtask targets a DIFFERENT file so the routed agents never contend.
 */
export class MockPlanner implements Planner {
  plan(prompt: string, _ctx: PlannerContext): PlannedSubtask[] {
    const slug = slugify(prompt) || 'task';
    // Three distinct roles, three distinct files. The orchestrator caps this by
    // maxAgents, but the default plan exercises the multi-agent path (>=2). The
    // distinct files are load-bearing: different files → different Y.Text → the
    // routed agents' concurrent edits can't contend.
    return [
      {
        role: 'architect',
        description: `Design the approach for: ${truncate(prompt, 80)}`,
        targetFile: `docs/${slug}.design.md`,
      },
      {
        role: 'coder',
        description: `Implement: ${truncate(prompt, 80)}`,
        targetFile: `src/${slug}.ts`,
      },
      {
        role: 'reviewer',
        description: `Review + add a test for: ${truncate(prompt, 80)}`,
        targetFile: `test/${slug}.test.ts`,
      },
    ];
  }
}

/**
 * Minimal chat-completion surface a real planner needs. Deliberately tiny and
 * provider-agnostic so the driver can adapt any BYO-key client (Anthropic,
 * OpenAI, a local model) to it without this module taking an SDK dependency.
 */
export interface PlannerLlmClient {
  /**
   * Return the assistant's text for a single planning prompt. Implementations
   * carry their own key/model. Should return strict JSON matching
   * {@link LlmPlanItem}[] (the planner validates + falls back if not).
   */
  complete(input: { system: string; user: string }): Promise<string>;
}

/** One item the LLM is asked to return (validated before use). */
export interface LlmPlanItem {
  role: AgentRole;
  description: string;
  targetFile?: string;
}

const VALID_ROLES: readonly AgentRole[] = ['architect', 'coder', 'debugger', 'reviewer'];

/**
 * BYO-key, LLM-routed planner (sketch). When a {@link PlannerLlmClient} is
 * injected it asks the model to decompose the prompt into role-tagged subtasks
 * and validates the JSON. With no client (CI / no key) it transparently falls
 * back to {@link MockPlanner} so callers get a working plan either way.
 */
export class LlmPlanner implements Planner {
  private readonly fallback = new MockPlanner();

  constructor(private readonly client?: PlannerLlmClient) {}

  async plan(prompt: string, ctx: PlannerContext): Promise<PlannedSubtask[]> {
    if (!this.client) return this.fallback.plan(prompt, ctx);

    const system =
      'You are the orchestrator for a squad of specialist coding agents. ' +
      'Roles: architect, coder, debugger, reviewer. Decompose the task into ' +
      '2-4 subtasks, each owned by ONE role, each editing a DIFFERENT file so ' +
      'agents never conflict. Reply with ONLY a JSON array of ' +
      '{role, description, targetFile}.';
    const user =
      `Task: ${prompt}\n\n` +
      (ctx.files.length ? `Existing files:\n${ctx.files.join('\n')}\n` : 'Empty workspace.\n');

    try {
      const raw = await this.client.complete({ system, user });
      const parsed = parsePlan(raw);
      if (parsed.length > 0) return parsed;
    } catch {
      // fall through to the deterministic plan on any failure
    }
    return this.fallback.plan(prompt, ctx);
  }
}

/** Parse + validate the model's JSON into safe {@link PlannedSubtask}s. */
function parsePlan(raw: string): PlannedSubtask[] {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonArray(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: PlannedSubtask[] = [];
  const usedFiles = new Set<string>();
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const role = rec.role;
    const description = rec.description;
    if (typeof role !== 'string' || !VALID_ROLES.includes(role as AgentRole)) continue;
    if (typeof description !== 'string' || description.trim().length === 0) continue;
    let targetFile =
      typeof rec.targetFile === 'string' && rec.targetFile.trim().length > 0
        ? rec.targetFile.trim()
        : undefined;
    // Enforce the distinct-file invariant even if the model repeats one.
    if (targetFile && usedFiles.has(targetFile)) targetFile = undefined;
    if (targetFile) usedFiles.add(targetFile);
    out.push({ role: role as AgentRole, description: description.trim(), targetFile });
  }
  return out;
}

/** Pull the first JSON array out of a possibly-chatty model reply. */
function extractJsonArray(raw: string): string {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

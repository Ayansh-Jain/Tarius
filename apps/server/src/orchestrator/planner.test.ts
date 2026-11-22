/**
 * Planner tests (v1.5) — the deterministic mock plan + the BYO-key LLM planner's
 * validation/fallback behavior. No key required.
 */
import { describe, it, expect } from 'vitest';
import { MockPlanner, LlmPlanner, type PlannerLlmClient } from './planner.js';
import type { PlannerContext } from './types.js';

const CTX: PlannerContext = { roomId: 'r', files: [] };

describe('MockPlanner', () => {
  it('decomposes any prompt into >=2 subtasks across distinct roles + files', () => {
    const plan = new MockPlanner().plan('build a login form', CTX);
    expect(plan.length).toBeGreaterThanOrEqual(2);

    const roles = plan.map((p) => p.role);
    expect(new Set(roles).size).toBe(roles.length); // distinct roles
    expect(roles).toContain('architect');
    expect(roles).toContain('coder');

    const files = plan.map((p) => p.targetFile);
    expect(files.every(Boolean)).toBe(true);
    expect(new Set(files).size).toBe(files.length); // distinct files
  });

  it('is deterministic for the same prompt', () => {
    const a = new MockPlanner().plan('same prompt', CTX);
    const b = new MockPlanner().plan('same prompt', CTX);
    expect(a).toEqual(b);
  });

  it('derives file names from the prompt slug', () => {
    const plan = new MockPlanner().plan('Add Dark Mode!!!', CTX);
    expect(plan.some((p) => p.targetFile?.includes('add-dark-mode'))).toBe(true);
  });
});

describe('LlmPlanner', () => {
  it('falls back to the deterministic plan when no client is configured', async () => {
    const plan = await new LlmPlanner().plan('do a thing', CTX);
    const mock = new MockPlanner().plan('do a thing', CTX);
    expect(plan).toEqual(mock);
  });

  it('uses a valid JSON plan returned by the injected client', async () => {
    const client: PlannerLlmClient = {
      async complete() {
        return JSON.stringify([
          { role: 'architect', description: 'design', targetFile: 'a.md' },
          { role: 'coder', description: 'implement', targetFile: 'b.ts' },
          { role: 'debugger', description: 'trace', targetFile: 'c.ts' },
        ]);
      },
    };
    const plan = await new LlmPlanner(client).plan('x', CTX);
    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.role)).toEqual(['architect', 'coder', 'debugger']);
    expect(plan.map((p) => p.targetFile)).toEqual(['a.md', 'b.ts', 'c.ts']);
  });

  it('extracts JSON even when the model adds prose around it', async () => {
    const client: PlannerLlmClient = {
      async complete() {
        return 'Sure! Here is the plan:\n[{"role":"coder","description":"do"}]\nHope that helps.';
      },
    };
    const plan = await new LlmPlanner(client).plan('x', CTX);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ role: 'coder', description: 'do' });
  });

  it('drops invalid roles + duplicate files, keeping the rest', async () => {
    const client: PlannerLlmClient = {
      async complete() {
        return JSON.stringify([
          { role: 'wizard', description: 'nope' }, // invalid role → dropped
          { role: 'coder', description: '' }, // empty desc → dropped
          { role: 'coder', description: 'ok', targetFile: 'dup.ts' },
          { role: 'reviewer', description: 'review', targetFile: 'dup.ts' }, // dup file → file cleared, kept
        ]);
      },
    };
    const plan = await new LlmPlanner(client).plan('x', CTX);
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ role: 'coder', targetFile: 'dup.ts' });
    expect(plan[1]).toMatchObject({ role: 'reviewer' });
    expect(plan[1]!.targetFile).toBeUndefined();
  });

  it('falls back when the client throws or returns garbage', async () => {
    const thrower: PlannerLlmClient = {
      async complete() {
        throw new Error('no key');
      },
    };
    const garbage: PlannerLlmClient = {
      async complete() {
        return 'not json at all';
      },
    };
    const fb = new MockPlanner().plan('q', CTX);
    expect(await new LlmPlanner(thrower).plan('q', CTX)).toEqual(fb);
    expect(await new LlmPlanner(garbage).plan('q', CTX)).toEqual(fb);
  });
});

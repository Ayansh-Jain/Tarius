/**
 * Policy engine tests (v1.5 Slice B). Pure decision layer — no git, no doc.
 *
 * Asserts the four rules that make the permission system trustworthy:
 *   • deny precedence (deny beats allow, even against ['*'] / writePaths),
 *   • tool allow-list (['*'] and explicit),
 *   • path-prefix scoping at segment boundaries (denyPaths beats writePaths),
 *   • requireApprovalForDestructive forces the propose-then-apply gate,
 * plus the PolicyRegistry's per-room/per-agent set/get + safe default.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '@ice/shared';
import {
  checkToolAllowed,
  checkWriteAllowed,
  enforce,
  requiresHumanGate,
  makePolicy,
  PolicyRegistry,
} from './index.js';

function policy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return makePolicy('agent-1', overrides);
}

describe('checkToolAllowed', () => {
  it('allows everything under the ["*"] wildcard', () => {
    const p = policy({ allowTools: ['*'] });
    expect(checkToolAllowed(p, 'fs/write')).toBe(true);
    expect(checkToolAllowed(p, 'run-command')).toBe(true);
  });

  it('allows only explicitly listed tools when not wildcarded', () => {
    const p = policy({ allowTools: ['fs/read', 'fs/write'] });
    expect(checkToolAllowed(p, 'fs/write')).toBe(true);
    expect(checkToolAllowed(p, 'run-command')).toBe(false);
  });

  it('DENY beats ALLOW — a denied tool is blocked even under ["*"]', () => {
    const p = policy({ allowTools: ['*'], denyTools: ['run-command'] });
    expect(checkToolAllowed(p, 'run-command')).toBe(false);
    expect(checkToolAllowed(p, 'fs/write')).toBe(true);
  });

  it('denies a tool that is in BOTH allow and deny (deny precedence)', () => {
    const p = policy({ allowTools: ['fs/write'], denyTools: ['fs/write'] });
    expect(checkToolAllowed(p, 'fs/write')).toBe(false);
  });
});

describe('checkWriteAllowed', () => {
  it('empty writePaths means unscoped — any path is writable', () => {
    const p = policy({ writePaths: [] });
    expect(checkWriteAllowed(p, 'anywhere/file.ts')).toBe(true);
    expect(checkWriteAllowed(p, 'README.md')).toBe(true);
  });

  it('scopes writes to the writePaths prefixes', () => {
    const p = policy({ writePaths: ['src', 'docs'] });
    expect(checkWriteAllowed(p, 'src/app.ts')).toBe(true);
    expect(checkWriteAllowed(p, 'docs/guide.md')).toBe(true);
    expect(checkWriteAllowed(p, 'secrets/key.pem')).toBe(false);
  });

  it('matches only at SEGMENT boundaries — "src" does not allow sibling "src-gen"', () => {
    const p = policy({ writePaths: ['src'] });
    expect(checkWriteAllowed(p, 'src/a.ts')).toBe(true);
    expect(checkWriteAllowed(p, 'src')).toBe(true); // the dir itself
    expect(checkWriteAllowed(p, 'src-gen/x.ts')).toBe(false);
  });

  it('denyPaths BEATS writePaths (deny precedence on paths)', () => {
    const p = policy({ writePaths: ['src'], denyPaths: ['src/secrets'] });
    expect(checkWriteAllowed(p, 'src/app.ts')).toBe(true);
    expect(checkWriteAllowed(p, 'src/secrets/token.ts')).toBe(false);
    expect(checkWriteAllowed(p, 'src/secrets')).toBe(false);
  });

  it('denyPaths subtracts even from an unscoped (empty writePaths) policy', () => {
    const p = policy({ writePaths: [], denyPaths: ['.env', 'node_modules'] });
    expect(checkWriteAllowed(p, 'src/app.ts')).toBe(true);
    expect(checkWriteAllowed(p, '.env')).toBe(false);
    expect(checkWriteAllowed(p, 'node_modules/x/index.js')).toBe(false);
  });

  it('normalizes leading ./ and trailing slashes before comparing', () => {
    const p = policy({ writePaths: ['src/'], denyPaths: ['./src/gen'] });
    expect(checkWriteAllowed(p, './src/app.ts')).toBe(true);
    expect(checkWriteAllowed(p, 'src/gen/out.ts')).toBe(false);
  });
});

describe('enforce — combined decision (the host hook)', () => {
  it('allows a permitted, non-destructive write outright', () => {
    const p = policy({ allowTools: ['fs/write'], writePaths: ['src'] });
    expect(enforce(p, { tool: 'fs/write', path: 'src/a.ts' })).toEqual({ effect: 'allow' });
  });

  it('denies a blocked tool with a legible reason', () => {
    const p = policy({ allowTools: ['*'], denyTools: ['run-command'] });
    const d = enforce(p, { tool: 'run-command', destructive: true });
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('tool-denied');
  });

  it('denies a write outside the writable paths (write gate)', () => {
    const p = policy({ allowTools: ['*'], writePaths: ['src'] });
    const d = enforce(p, { tool: 'fs/write', path: 'secrets/x.ts' });
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('write-not-allowed');
  });

  it('denyPaths inside an allowed write still denies (deny precedence wins in enforce too)', () => {
    const p = policy({ allowTools: ['*'], writePaths: ['src'], denyPaths: ['src/secrets'] });
    const d = enforce(p, { tool: 'fs/write', path: 'src/secrets/k.ts' });
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('write-denied');
  });

  it('forces the approval gate for a permitted DESTRUCTIVE op (propose-then-apply)', () => {
    const p = policy({ allowTools: ['*'], requireApprovalForDestructive: true });
    const d = enforce(p, { tool: 'fs/delete', path: 'src/old.ts', destructive: true });
    expect(d).toEqual({ effect: 'require-approval', reason: 'destructive' });
  });

  it('allows a destructive op immediately when approval is NOT required', () => {
    const p = policy({ allowTools: ['*'], requireApprovalForDestructive: false });
    expect(enforce(p, { tool: 'fs/delete', path: 'a.ts', destructive: true })).toEqual({
      effect: 'allow',
    });
  });

  it('a denied destructive tool is DENIED, not merely gated (deny checked first)', () => {
    const p = policy({ allowTools: ['*'], denyTools: ['fs/delete'], requireApprovalForDestructive: true });
    const d = enforce(p, { tool: 'fs/delete', path: 'a.ts', destructive: true });
    expect(d.effect).toBe('deny');
  });

  it('requiresHumanGate is true for deny + require-approval, false for allow', () => {
    const gated = policy({ allowTools: ['*'], requireApprovalForDestructive: true });
    expect(requiresHumanGate(gated, { tool: 'fs/delete', destructive: true })).toBe(true);
    const denied = policy({ allowTools: ['fs/read'] });
    expect(requiresHumanGate(denied, { tool: 'fs/write' })).toBe(true);
    const ok = policy({ allowTools: ['*'] });
    expect(requiresHumanGate(ok, { tool: 'fs/write', path: 'a.ts' })).toBe(false);
  });
});

describe('PolicyRegistry', () => {
  it('stores and retrieves per-room, per-agent policies', () => {
    const reg = new PolicyRegistry();
    const pa = makePolicy('a', { allowTools: ['fs/read'] });
    const pb = makePolicy('b', { allowTools: ['*'] });
    reg.set('room-1', pa);
    reg.set('room-1', pb);
    expect(reg.get('room-1', 'a').allowTools).toEqual(['fs/read']);
    expect(reg.get('room-1', 'b').allowTools).toEqual(['*']);
  });

  it('isolates policies across rooms', () => {
    const reg = new PolicyRegistry();
    reg.set('room-1', makePolicy('a', { denyTools: ['run-command'] }));
    expect(reg.has('room-1', 'a')).toBe(true);
    expect(reg.has('room-2', 'a')).toBe(false);
    // room-2 agent 'a' falls back to the default (permissive-but-gated).
    expect(reg.get('room-2', 'a').allowTools).toEqual(['*']);
  });

  it('returns a safe permissive-but-gated default for an un-set agent', () => {
    const reg = new PolicyRegistry();
    const def = reg.get('room-x', 'never-set');
    expect(def.allowTools).toEqual(['*']);
    expect(def.requireApprovalForDestructive).toBe(true);
    // and that default still gates destructive ops:
    expect(reg.enforce('room-x', 'never-set', { tool: 'fs/delete', destructive: true })).toEqual({
      effect: 'require-approval',
      reason: 'destructive',
    });
  });

  it('delete drops a policy back to the default', () => {
    const reg = new PolicyRegistry();
    reg.set('room-1', makePolicy('a', { allowTools: ['fs/read'] }));
    reg.delete('room-1', 'a');
    expect(reg.has('room-1', 'a')).toBe(false);
    expect(reg.get('room-1', 'a').allowTools).toEqual(['*']);
  });

  it('list returns explicitly-set policies for a room', () => {
    const reg = new PolicyRegistry();
    reg.set('room-1', makePolicy('a'));
    reg.set('room-1', makePolicy('b'));
    reg.set('room-2', makePolicy('c'));
    expect(reg.list('room-1').map((p) => p.agentId).sort()).toEqual(['a', 'b']);
    expect(reg.list('room-2').map((p) => p.agentId)).toEqual(['c']);
  });
});

/**
 * Community extension loader tests (v2.0 Slice C).
 *
 * Proves the loader against REAL manifest files written to a temp dir — no
 * mocks, deterministic in CI:
 *   - a valid mcp manifest + a valid agent manifest are discovered, validated,
 *     and narrowed (spec typed per kind).
 *   - malformed manifests (bad JSON, missing id/name/spec, unknown kind, a spec
 *     that doesn't match its kind) are ignored, and DON'T sink the good ones.
 *   - listByKind / get behave; ordering is stable (by id).
 *   - ICE_EXTENSIONS accepts both a directory and a single file (delimiter-joined).
 *   - duplicate ids: first wins.
 *   - unset / missing-path env → empty loader (optional), and never throws.
 *   - validateManifest works as a pure (disk-free) validator.
 *   - EMPTY_EXTENSION_LOADER offers nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter as PATH_DELIMITER, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXTENSIONS_ENV,
  loadExtensions,
  makeExtensionLoader,
  validateManifest,
} from './loader.js';
import { EMPTY_EXTENSION_LOADER, type LoadedExtension } from './types.js';

/** Silent logger so test output stays clean; bad manifests are expected. */
const QUIET = { warn: () => {} };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ice-ext-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `obj` (or raw string) as `<name>.json` into the temp dir. */
function write(name: string, obj: unknown): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return file;
}

describe('loadExtensions', () => {
  it('returns an empty loader when ICE_EXTENSIONS is unset or blank', () => {
    expect(loadExtensions({}, QUIET).list()).toEqual([]);
    expect(loadExtensions({ [EXTENSIONS_ENV]: '   ' }, QUIET).list()).toEqual([]);
  });

  it('does not throw and stays empty when a configured path is missing', () => {
    const env = { [EXTENSIONS_ENV]: join(dir, 'does-not-exist') };
    expect(() => loadExtensions(env, QUIET)).not.toThrow();
    expect(loadExtensions(env, QUIET).list()).toEqual([]);
  });

  it('discovers and validates a valid mcp manifest + a valid agent manifest', () => {
    write('search', {
      id: 'acme.search',
      kind: 'mcp',
      name: 'Acme Search',
      description: 'search tools',
      version: '1.2.0',
      homepage: 'https://example.com/search',
      spec: { command: 'npx', args: ['-y', '@acme/search-mcp'], timeoutMs: 5000 },
    });
    write('reviewer', {
      id: 'acme.reviewer',
      kind: 'agent',
      name: 'Acme Reviewer',
      spec: { backend: 'claude-code', model: 'sonnet' },
    });

    const loader = loadExtensions({ [EXTENSIONS_ENV]: dir }, QUIET);
    const all = loader.list();
    expect(all.map((e) => e.manifest.id)).toEqual(['acme.reviewer', 'acme.search']); // sorted by id

    const mcp = loader.listByKind('mcp');
    expect(mcp).toHaveLength(1);
    const mcpExt = mcp[0]!;
    expect(mcpExt.manifest.kind).toBe('mcp');
    if (mcpExt.manifest.kind === 'mcp') {
      expect(mcpExt.manifest.spec).toEqual({
        command: 'npx',
        args: ['-y', '@acme/search-mcp'],
        timeoutMs: 5000,
      });
    }
    expect(mcpExt.sourcePath.endsWith('search.json')).toBe(true);

    const agents = loader.listByKind('agent');
    expect(agents).toHaveLength(1);
    const agentExt = agents[0]!;
    if (agentExt.manifest.kind === 'agent') {
      expect(agentExt.manifest.spec).toEqual({ backend: 'claude-code', model: 'sonnet' });
    }

    expect(loader.get('acme.search')?.manifest.name).toBe('Acme Search');
    expect(loader.get('nope')).toBeUndefined();
  });

  it('ignores malformed manifests but still loads the valid ones', () => {
    // The one good manifest:
    write('good', {
      id: 'ok.one',
      kind: 'mcp',
      name: 'Good',
      spec: { command: 'run-me' },
    });
    // A grab-bag of bad ones — each must be skipped, none may throw:
    write('not-json', '{ this is : not json');
    write('array', [1, 2, 3]);
    write('no-id', { kind: 'mcp', name: 'x', spec: { command: 'c' } });
    write('no-name', { id: 'bad.noname', kind: 'mcp', spec: { command: 'c' } });
    write('no-spec', { id: 'bad.nospec', kind: 'mcp', name: 'x' });
    write('bad-kind', { id: 'bad.kind', kind: 'plugin', name: 'x', spec: {} });
    write('mcp-no-cmd', { id: 'bad.mcpnocmd', kind: 'mcp', name: 'x', spec: { args: ['a'] } });
    write('agent-no-backend', {
      id: 'bad.agentnobackend',
      kind: 'agent',
      name: 'x',
      spec: { model: 'm' },
    });
    // A non-.json file in the same dir must be ignored entirely.
    writeFileSync(join(dir, 'README.md'), '# not a manifest');

    const loader = loadExtensions({ [EXTENSIONS_ENV]: dir }, QUIET);
    expect(loader.list().map((e) => e.manifest.id)).toEqual(['ok.one']);
  });

  it('accepts a directory and a single file together (delimiter-joined)', () => {
    write('indir', { id: 'a.indir', kind: 'mcp', name: 'InDir', spec: { command: 'c' } });

    // A standalone manifest file outside `dir`:
    const loose = mkdtempSync(join(tmpdir(), 'ice-ext-loose-'));
    const looseFile = join(loose, 'loose.json');
    writeFileSync(
      looseFile,
      JSON.stringify({ id: 'a.loose', kind: 'agent', name: 'Loose', spec: { backend: 'mock' } }),
    );

    try {
      const env = { [EXTENSIONS_ENV]: `${dir}${PATH_DELIMITER}${looseFile}` };
      const loader = loadExtensions(env, QUIET);
      expect(loader.list().map((e) => e.manifest.id)).toEqual(['a.indir', 'a.loose']);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });

  it('drops duplicate ids, keeping the first', () => {
    write('a-first', { id: 'dup.id', kind: 'mcp', name: 'First', spec: { command: 'first' } });
    write('b-second', { id: 'dup.id', kind: 'mcp', name: 'Second', spec: { command: 'second' } });

    const loader = loadExtensions({ [EXTENSIONS_ENV]: dir }, QUIET);
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.manifest.name).toBe('First'); // a-first.json sorts before b-second.json
  });

  it('ignores a non-.json file passed directly', () => {
    const file = join(dir, 'manifest.txt');
    writeFileSync(file, JSON.stringify({ id: 'x.y', kind: 'mcp', name: 'n', spec: { command: 'c' } }));
    expect(loadExtensions({ [EXTENSIONS_ENV]: file }, QUIET).list()).toEqual([]);
  });
});

describe('validateManifest (pure)', () => {
  it('narrows a valid mcp manifest', () => {
    const m = validateManifest(
      { id: 'x.mcp', kind: 'mcp', name: 'X', spec: { command: 'c', args: ['a'] } },
      'inline',
      QUIET,
    );
    expect(m?.kind).toBe('mcp');
    expect(m?.kind === 'mcp' && m.spec.command).toBe('c');
  });

  it('rejects a non-object, a bad kind, and a mismatched spec', () => {
    expect(validateManifest(42, 'inline', QUIET)).toBeNull();
    expect(validateManifest({ id: 'a', kind: 'nope', name: 'n', spec: {} }, 'inline', QUIET)).toBeNull();
    // kind 'agent' but spec is an mcp-shaped object without a backend → rejected.
    expect(
      validateManifest({ id: 'a', kind: 'agent', name: 'n', spec: { command: 'c' } }, 'inline', QUIET),
    ).toBeNull();
  });
});

describe('makeExtensionLoader / EMPTY_EXTENSION_LOADER', () => {
  it('wraps a fixed list with a stable order', () => {
    const items: LoadedExtension[] = [
      {
        sourcePath: '/b.json',
        manifest: { id: 'b.two', kind: 'agent', name: 'B', spec: { backend: 'mock' } },
      },
      {
        sourcePath: '/a.json',
        manifest: { id: 'a.one', kind: 'mcp', name: 'A', spec: { command: 'c' } },
      },
    ];
    const loader = makeExtensionLoader(items);
    expect(loader.list().map((e) => e.manifest.id)).toEqual(['a.one', 'b.two']);
    expect(loader.listByKind('mcp').map((e) => e.manifest.id)).toEqual(['a.one']);
  });

  it('EMPTY_EXTENSION_LOADER offers nothing', () => {
    expect(EMPTY_EXTENSION_LOADER.list()).toEqual([]);
    expect(EMPTY_EXTENSION_LOADER.listByKind('mcp')).toEqual([]);
    expect(EMPTY_EXTENSION_LOADER.get('anything')).toBeUndefined();
  });
});

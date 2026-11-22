import { describe, expect, it } from 'vitest';
import { buildPrompt, parseMentions, parseReply, resolveMention, retrieve, wantsOptimisation } from './assist.js';

const files = new Map([
  ['l.cpp', 'int main(){return 0;}\n'],
  ['src/util.py', 'x = 1\n'],
  ['main.ts', 'let a = 1;\n'],
]);

describe('assist retrieval', () => {
  it('parses @mentions and trims sentence punctuation', () => {
    expect(parseMentions('fix @l.cpp. and compare with @src/util.py, thanks')).toEqual(['l.cpp', 'src/util.py']);
    expect(parseMentions('mail me at a@b.com')).toEqual([]);
  });
  it('resolves by path, basename and case', () => {
    const paths = [...files.keys()];
    expect(resolveMention('src/util.py', paths)).toBe('src/util.py');
    expect(resolveMention('util.py', paths)).toBe('src/util.py');
    expect(resolveMention('L.CPP', paths)).toBe('l.cpp');
    expect(resolveMention('nope.c', paths)).toBeNull();
  });
  it('always includes the active file; first mention becomes the target', () => {
    const r = retrieve('fix @util.py using @l.cpp @ghost.c', 'main.ts', files);
    expect(r.files.map((f) => f.path)).toEqual(['main.ts', 'src/util.py', 'l.cpp']);
    expect(r.target).toBe('src/util.py');
    expect(r.unresolved).toEqual(['ghost.c']);
  });
  it('falls back to the active file as target', () => {
    expect(retrieve('why does this crash', 'l.cpp', files).target).toBe('l.cpp');
    expect(retrieve('hi', null, files).target).toBeNull();
  });
});

describe('assist prompt + reply', () => {
  it('only allows optimisation when explicitly requested', () => {
    expect(wantsOptimisation('fix the segfault')).toBe(false);
    expect(wantsOptimisation('please optimise this loop')).toBe(true);
    const c = retrieve('fix it', 'l.cpp', files).files;
    expect(buildPrompt('fix it', 'l.cpp', c, [...files.keys()])).toContain('did NOT ask for optimisation');
    expect(buildPrompt('optimize it', 'l.cpp', c, [...files.keys()])).toContain('EXPLICITLY asked');
  });
  it('splits explanation from the last code block and strips an echoed gutter', () => {
    const r = parseReply('Fixed the return.\n```cpp\nint main(){\n  return 1;\n}\n```');
    expect(r.explanation).toBe('Fixed the return.');
    expect(r.code).toBe('int main(){\n  return 1;\n}\n');
    expect(parseReply('ok\n```\n   1| a\n   2| b\n```').code).toBe('a\nb\n');
    expect(parseReply('no code here').code).toBeNull();
  });
});

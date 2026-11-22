import { describe, expect, it } from 'vitest';
import { normaliseRemoteUrl, GithubError } from './github.js';

describe('github remote url', () => {
  it('normalises github https urls', () => {
    expect(normaliseRemoteUrl('https://github.com/me/repo')).toBe('https://github.com/me/repo.git');
    expect(normaliseRemoteUrl('https://github.com/me/repo.git/')).toBe('https://github.com/me/repo.git');
    expect(normaliseRemoteUrl(' https://github.com/me/my.repo-1 ')).toBe('https://github.com/me/my.repo-1.git');
  });
  it('rejects anything else', () => {
    for (const bad of ['http://github.com/a/b', 'https://evil.com/a/b', 'git@github.com:a/b.git', 'https://github.com/a', 'https://github.com/a/b/c']) {
      expect(() => normaliseRemoteUrl(bad)).toThrow(GithubError);
    }
  });
});

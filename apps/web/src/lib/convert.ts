/** Client for the code-conversion API + language helpers. */
export const LANGS = [
  { id: 'javascript', label: 'JavaScript', ext: 'js' },
  { id: 'typescript', label: 'TypeScript', ext: 'ts' },
  { id: 'python', label: 'Python', ext: 'py' },
  { id: 'cpp', label: 'C++', ext: 'cpp' },
  { id: 'java', label: 'Java', ext: 'java' },
] as const;
export type LangId = (typeof LANGS)[number]['id'];

export function langLabel(id: LangId): string {
  return LANGS.find((l) => l.id === id)?.label ?? id;
}

/** Guess the language from a file path; null when it isn't one we can convert. */
export function detectLang(path: string): LangId | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  switch (m?.[1]?.toLowerCase()) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'py':
      return 'python';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'h':
      return 'cpp';
    case 'java':
      return 'java';
    default:
      return null;
  }
}

export function extFor(id: LangId): string {
  return LANGS.find((l) => l.id === id)?.ext ?? 'txt';
}

const GENERIC_FAIL = 'We could not convert this file right now. Please try again.';

export async function convertCode(code: string, from: LangId, to: LangId): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code, from, to }),
    });
  } catch {
    throw new Error(GENERIC_FAIL);
  }
  if (res.status === 413) throw new Error('This file is too large to convert.');
  if (!res.ok) throw new Error(GENERIC_FAIL);
  const body = (await res.json()) as { code?: string };
  if (typeof body.code !== 'string') throw new Error(GENERIC_FAIL);
  return body.code;
}

export type ApiStatus = 'checking' | 'working' | 'unavailable' | 'not_configured';

export async function fetchApiStatus(recheck = false): Promise<ApiStatus> {
  try {
    const res = await fetch(recheck ? '/api/convert/status/recheck' : '/api/convert/status', {
      method: recheck ? 'POST' : 'GET',
      credentials: 'include',
    });
    if (!res.ok) return 'unavailable';
    return ((await res.json()) as { status: ApiStatus }).status;
  } catch {
    return 'unavailable';
  }
}

/** Client for the AI assistant (RAG + Gemini) endpoint and @-mention helpers. */
export interface AssistResponse {
  path: string;
  explanation: string;
  /** Full corrected file. */
  code: string;
  context: string[];
  unresolved: string[];
}

export async function askAssistant(
  roomId: string,
  prompt: string,
  activePath: string | null,
  signal?: AbortSignal,
): Promise<AssistResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ prompt, activePath }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => ({}))) as Partial<AssistResponse> & { message?: string };
  if (!res.ok) throw new Error(data.message ?? 'The assistant could not answer right now. Please try again.');
  if (typeof data.code !== 'string' || typeof data.path !== 'string') {
    throw new Error('The assistant returned an unexpected response.');
  }
  return {
    path: data.path,
    explanation: data.explanation ?? '',
    code: data.code,
    context: data.context ?? [],
    unresolved: data.unresolved ?? [],
  };
}

/** The `@query` the caret is currently inside, if any. */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s([,;])@([\w.\-/\\]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Rank files for an @query: basename prefix, then basename substring, then path substring. */
export function rankFiles(paths: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return paths.slice(0, limit);
  const score = (p: string): number => {
    const lower = p.toLowerCase();
    const base = lower.split('/').pop()!;
    if (base.startsWith(q)) return 0;
    if (base.includes(q)) return 1;
    if (lower.includes(q)) return 2;
    return 3;
  };
  return paths
    .filter((p) => score(p) < 3)
    .sort((a, b) => score(a) - score(b) || a.length - b.length)
    .slice(0, limit);
}

/** Paths referenced with @ in the prompt (same matching rules as the server). */
export function mentionedPaths(prompt: string, paths: string[]): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  const re = /(^|[\s([,;])@([\w.\-/\\]+)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    const name = m[2]!.replace(/\\/g, '/').replace(/[.,;:!?]+$/, '').replace(/^\/+/, '');
    if (!name) continue;
    const lower = name.toLowerCase();
    const hit =
      paths.find((p) => p === name) ??
      paths.find((p) => p.toLowerCase() === lower) ??
      [...paths].sort((a, b) => a.length - b.length).find((p) => p.split('/').pop()!.toLowerCase() === lower) ??
      [...paths].sort((a, b) => a.length - b.length).find((p) => p.toLowerCase().endsWith('/' + lower));
    if (hit) {
      if (!found.includes(hit)) found.push(hit);
    } else if (!missing.includes(name)) missing.push(name);
  }
  return { found, missing };
}

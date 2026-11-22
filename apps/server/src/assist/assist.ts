/**
 * AI assistant (RAG over the room's files, answered by Gemini).
 *
 * Retrieval: the file the user is looking at is always included, plus every file
 * they reference with `@name` in the prompt (full path or unambiguous basename).
 * Augmentation: those files are put in the prompt verbatim, together with strict
 * "make the smallest fix" rules. Generation: Gemini returns the corrected FULL
 * file for the target; the client diffs it against the current text and shows
 * exactly what changed.
 */
import { geminiGenerate } from '../convert/convert.js';

export const MAX_ASSIST_FILE_CHARS = 60_000;
export const MAX_ASSIST_CONTEXT_CHARS = 150_000;
export const MAX_ASSIST_PROMPT_CHARS = 4_000;

export interface RetrievedFile {
  path: string;
  content: string;
  /** Why it is in the context. */
  reason: 'active' | 'mention';
}

export interface AssistResult {
  /** File the corrected code is for. */
  path: string;
  explanation: string;
  /** Full corrected file contents. */
  code: string;
  /** Files that were sent to the model as context. */
  context: string[];
  /** Mentions that matched no file. */
  unresolved: string[];
}

export function assistKey(): string | null {
  const k = (process.env.GEMINI_API_KEY ?? process.env.GEMINI_CONVERT_API_KEY)?.trim();
  return k ? k : null;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/** `@name` tokens in the prompt, in order, without the `@`. */
export function parseMentions(prompt: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s([,;])@([\w.\-/\\]+)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    // A trailing sentence period ("fix @a.cpp.") is not part of the name.
    const name = m[2]!.replace(/\\/g, '/').replace(/[.,;:!?]+$/, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Resolve a mention to a file path: exact path, then unique basename, then unique suffix. */
export function resolveMention(name: string, paths: string[]): string | null {
  const clean = name.replace(/^\/+/, '');
  if (paths.includes(clean)) return clean;
  const lower = clean.toLowerCase();
  const exactCi = paths.filter((p) => p.toLowerCase() === lower);
  if (exactCi.length === 1) return exactCi[0]!;
  const byBase = paths.filter((p) => p.split('/').pop()!.toLowerCase() === lower);
  if (byBase.length >= 1) return byBase.sort((a, b) => a.length - b.length)[0]!;
  const bySuffix = paths.filter((p) => p.toLowerCase().endsWith('/' + lower));
  return bySuffix.length >= 1 ? bySuffix.sort((a, b) => a.length - b.length)[0]! : null;
}

export function retrieve(
  prompt: string,
  activePath: string | null,
  files: ReadonlyMap<string, string>,
): { files: RetrievedFile[]; unresolved: string[]; target: string | null } {
  const paths = [...files.keys()];
  const picked: RetrievedFile[] = [];
  const unresolved: string[] = [];
  const mentioned: string[] = [];
  for (const name of parseMentions(prompt)) {
    const p = resolveMention(name, paths);
    if (!p) unresolved.push(name);
    else if (!mentioned.includes(p)) mentioned.push(p);
  }
  if (activePath && files.has(activePath)) {
    picked.push({ path: activePath, content: files.get(activePath)!, reason: 'active' });
  }
  for (const p of mentioned) {
    if (!picked.some((f) => f.path === p)) picked.push({ path: p, content: files.get(p)!, reason: 'mention' });
  }
  // The file to fix: the first @-referenced file, otherwise the one being viewed.
  const target = mentioned[0] ?? (activePath && files.has(activePath) ? activePath : null);
  return { files: picked, unresolved, target };
}

// ── Augmentation ─────────────────────────────────────────────────────────────

const SYSTEM = [
  'You are a careful code-fixing assistant inside a collaborative IDE.',
  'You receive the user request and the source of the relevant files, then return the corrected version of ONE target file.',
  '',
  'HARD RULES:',
  '1. Make the SMALLEST change that satisfies the request. Do not rewrite or restructure working code.',
  '2. Keep the same variable, function and class names, the same algorithm/approach, the same formatting, indentation and comments.',
  '3. Do not rename, reorder, add features or "improve" anything that was not asked for.',
  '4. Only optimise, refactor or change the approach if the request explicitly asks for it (the request below tells you whether it does).',
  '5. The other files are read-only context; never output them.',
  '6. Return the COMPLETE target file (not a snippet or a diff) so it can replace the original.',
  '',
  'OUTPUT FORMAT (exactly):',
  'First, 1-4 short plain-text sentences explaining what was wrong and what you changed (mention line numbers or names).',
  'Then ONE fenced code block containing the full corrected target file, and nothing after it.',
  'If the file already satisfies the request, say so in the explanation and return the file unchanged.',
].join('\n');

const OPTIMISE_RE = /\b(optimi[sz]e|optimi[sz]ation|refactor|rewrite|speed\s*up|make\s+(it\s+)?faster|improve\s+performance|more\s+efficient|cleaner)\b/i;

export function wantsOptimisation(prompt: string): boolean {
  return OPTIMISE_RE.test(prompt);
}

function langOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', c: 'c', py: 'python', js: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx', java: 'java', go: 'go', rs: 'rust', html: 'html', css: 'css', json: 'json',
  };
  return map[ext] ?? '';
}

/** Numbered so the model can cite lines; the numbers are NOT part of the code. */
function numbered(content: string): string {
  return content
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n');
}

export function buildPrompt(
  userPrompt: string,
  target: string,
  context: RetrievedFile[],
  allPaths: string[],
): string {
  const optimise = wantsOptimisation(userPrompt);
  const parts: string[] = [];
  parts.push(`TARGET FILE TO CORRECT: ${target}`);
  parts.push(
    optimise
      ? 'The user EXPLICITLY asked for optimisation/refactoring, so you may improve the approach where it serves the request.'
      : 'The user did NOT ask for optimisation: keep the existing variables, structure and approach, and change only what is needed.',
  );
  parts.push(`Files in the workspace: ${allPaths.slice(0, 200).join(', ') || '(none)'}`);
  for (const f of context) {
    const role = f.path === target ? 'TARGET' : 'CONTEXT (read-only)';
    parts.push(
      `----- ${role}: ${f.path} (line numbers shown as "N| " are not part of the code) -----\n` +
        '```' + langOf(f.path) + '\n' + numbered(f.content) + '\n```',
    );
  }
  parts.push(`USER REQUEST:\n${userPrompt}`);
  parts.push(`Remember: output a short explanation, then the complete corrected ${target} in one fenced code block.`);
  return parts.join('\n\n');
}

// ── Generation ───────────────────────────────────────────────────────────────

/** Split the model reply into the prose explanation and the final fenced code block. */
export function parseReply(text: string): { explanation: string; code: string | null } {
  const blocks = [...text.matchAll(/```[\w+#-]*[ \t]*\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return { explanation: text.trim(), code: null };
  const last = blocks[blocks.length - 1]!;
  const explanation = text.slice(0, last.index).trim();
  // Models sometimes echo the line-number gutter; strip it only if EVERY line has it.
  let code = last[1]!;
  const lines = code.split('\n');
  const body = lines.filter((l) => l.length > 0);
  if (body.length > 0 && body.every((l) => /^\s*\d+\| ?/.test(l))) {
    code = lines.map((l) => l.replace(/^\s*\d+\| ?/, '')).join('\n');
  }
  return { explanation, code: code.replace(/\s+$/, '') + '\n' };
}

export class AssistError extends Error {
  constructor(
    readonly code: 'not_configured' | 'no_file' | 'too_large' | 'model_failed' | 'bad_reply',
    message: string,
  ) {
    super(message);
  }
}

export async function runAssist(
  userPrompt: string,
  activePath: string | null,
  files: ReadonlyMap<string, string>,
): Promise<AssistResult> {
  const key = assistKey();
  if (!key) throw new AssistError('not_configured', 'No Gemini API key is configured (GEMINI_API_KEY).');

  const r = retrieve(userPrompt, activePath, files);
  if (!r.target) throw new AssistError('no_file', 'Open a file or reference one with @filename.');
  let total = 0;
  for (const f of r.files) {
    if (f.content.length > MAX_ASSIST_FILE_CHARS) {
      throw new AssistError('too_large', `${f.path} is too large to send (limit ${MAX_ASSIST_FILE_CHARS} characters).`);
    }
    total += f.content.length;
  }
  if (total > MAX_ASSIST_CONTEXT_CHARS) {
    throw new AssistError('too_large', 'The referenced files are too large to send together.');
  }

  const prompt = buildPrompt(userPrompt, r.target, r.files, [...files.keys()]);
  let reply: string;
  try {
    reply = await geminiGenerate(prompt, 120_000, 32_768, { key, system: SYSTEM, temperature: 0.1 });
  } catch {
    throw new AssistError('model_failed', 'The AI service did not respond. Please try again.');
  }
  const { explanation, code } = parseReply(reply);
  if (code === null || !code.trim()) {
    throw new AssistError('bad_reply', explanation || 'The AI did not return any code. Try rephrasing your request.');
  }
  return {
    path: r.target,
    explanation: explanation || 'Here is the corrected code.',
    code,
    context: r.files.map((f) => f.path),
    unresolved: r.unresolved,
  };
}

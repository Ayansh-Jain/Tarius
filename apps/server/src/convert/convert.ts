/**
 * Code conversion between the supported languages (Python, JavaScript, TypeScript, C++, Java).
 *
 * Strategy: try the local engine first (convert_cli.py -> transpiler.py: a real lexer/parser/
 * type-inferring code generator that needs no network; its output is syntax-checked with the
 * real toolchain). If that fails for ANY reason, ask Gemini using
 * a dedicated key (GEMINI_CONVERT_API_KEY). Callers only ever see the converted
 * code or one generic failure; which path produced it is never exposed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONVERT_LANGS = ['cpp', 'python', 'java', 'javascript', 'typescript'] as const;
export type ConvertLang = (typeof CONVERT_LANGS)[number];

export const MAX_CONVERT_CHARS = 60_000;

const LANG_LABEL: Record<ConvertLang, string> = {
  cpp: 'C++',
  python: 'Python',
  java: 'Java',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'convert_cli.py');

export function isConvertLang(v: unknown): v is ConvertLang {
  return typeof v === 'string' && (CONVERT_LANGS as readonly string[]).includes(v);
}

// ── Manual (local engine) ────────────────────────────────────────────────────

function pythonCandidates(): string[] {
  const fromEnv = process.env.ICE_PYTHON;
  if (fromEnv) return [fromEnv];
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

function runPython(bin: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [CLI], {
      env: { ...process.env, ICE_NODE_BIN: process.execPath, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function convertManual(code: string, from: ConvertLang, to: ConvertLang): Promise<string | null> {
  const input = JSON.stringify({ code, src: from, tgt: to });
  for (const bin of pythonCandidates()) {
    try {
      const out = await runPython(bin, input, 45_000);
      const parsed = JSON.parse(out) as { ok?: boolean; code?: string };
      return parsed.ok && typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code : null;
    } catch {
      // try the next interpreter name
    }
  }
  return null;
}

// ── Gemini (backup) ──────────────────────────────────────────────────────────

function geminiKey(): string | null {
  const k = process.env.GEMINI_CONVERT_API_KEY?.trim();
  return k ? k : null;
}

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/** Tried in order; the last one that worked is promoted to the front. */
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
let lastGoodModel: string | null = null;

function modelCandidates(): string[] {
  const custom = process.env.GEMINI_CONVERT_MODEL?.trim();
  const list = [...(custom ? [custom] : []), ...DEFAULT_MODELS];
  if (lastGoodModel) list.unshift(lastGoodModel);
  return [...new Set(list)];
}

export interface GeminiOptions {
  /** API key override (defaults to GEMINI_CONVERT_API_KEY). */
  key?: string;
  /** System instruction (kept separate from the user prompt). */
  system?: string;
  temperature?: number;
}

export async function geminiGenerate(
  prompt: string,
  timeoutMs: number,
  maxTokens: number,
  opts: GeminiOptions = {},
): Promise<string> {
  const key = opts.key ?? geminiKey();
  if (!key) throw new Error('no key');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    generationConfig: { temperature: opts.temperature ?? 0, maxOutputTokens: maxTokens },
  });
  for (const model of modelCandidates()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        break; // network/timeout: move on to the next model
      }
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        if (!text.trim()) break;
        lastGoodModel = model;
        return text;
      }
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        throw new Error(`http ${res.status}`); // key/request problem: other models will not help
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      break; // 404 (retired) or still overloaded: next model
    }
  }
  throw new Error('unavailable');
}

export function stripFences(text: string): string {
  const m = /```[\w+#-]*\s*\n([\s\S]*?)```/.exec(text);
  return (m ? m[1]! : text).replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n';
}

async function convertWithGemini(code: string, from: ConvertLang, to: ConvertLang): Promise<string | null> {
  if (!geminiKey()) return null;
  const prompt =
    `Convert the following ${LANG_LABEL[from]} source file into ${LANG_LABEL[to]}.\n` +
    `Rules: preserve behavior, structure, names and comments; use idiomatic ${LANG_LABEL[to]} and its standard library; ` +
    `the result must compile/run as a complete file. Output ONLY the converted code in a single fenced code block, with no explanation.\n\n` +
    '```\n' + code + '\n```';
  try {
    const out = await geminiGenerate(prompt, 90_000, 16_384);
    const cleaned = stripFences(out);
    return cleaned.trim() ? cleaned : null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns converted code, or null if every route failed. */
export async function convertCode(code: string, from: ConvertLang, to: ConvertLang): Promise<string | null> {
  if (from === to) return code;
  if (!code.trim()) return code;
  const manual = await convertManual(code, from, to);
  if (manual) return manual;
  return convertWithGemini(code, from, to);
}

// ── Backup API status (checked at startup) ───────────────────────────────────

export type ApiStatus = 'checking' | 'working' | 'unavailable' | 'not_configured';
let apiStatus: ApiStatus = geminiKey() ? 'checking' : 'not_configured';
let apiCheckedAt: number | null = null;

export function getApiStatus(): { status: ApiStatus; checkedAt: number | null } {
  return { status: apiStatus, checkedAt: apiCheckedAt };
}

/** Send one tiny example request and record whether the key works. */
export async function checkApiStatus(): Promise<ApiStatus> {
  if (!geminiKey()) {
    apiStatus = 'not_configured';
    apiCheckedAt = Date.now();
    return apiStatus;
  }
  apiStatus = 'checking';
  try {
    const out = await geminiGenerate('Reply with the single word: ok', 20_000, 64);
    apiStatus = out.trim().length > 0 ? 'working' : 'unavailable';
  } catch {
    apiStatus = 'unavailable';
  }
  apiCheckedAt = Date.now();
  return apiStatus;
}

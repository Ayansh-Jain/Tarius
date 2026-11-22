/**
 * Static, decorative preview of the workspace for the homepage hero.
 *
 * ISOLATED DESIGN PREVIEW: the content below is illustrative sample data and is
 * never wired to the live room, terminal, or agent. It is aria-hidden.
 */
import { Bot, FileCode2, Folder, Terminal } from 'lucide-react';

const LINES: Array<Array<[string, string]>> = [
  [['kw', 'import'], ['tx', ' { serve } '], ['kw', 'from'], ['st', " './server'"]],
  [],
  [['kw', 'const'], ['fn', ' app'], ['tx', ' = '], ['fn', 'serve'], ['tx', '({ port: '], ['nu', '3000'], ['tx', ' })']],
  [],
  [['cm', '// shared cursor, live']],
  [['fn', 'app'], ['tx', '.'], ['fn', 'get'], ['tx', '('], ['st', "'/'"], ['tx', ', (c) => c.'], ['fn', 'text'], ['tx', '('], ['st', "'hello'"], ['tx', '))']],
];

const TONE: Record<string, string> = {
  kw: 'text-[#B1A4DD]',
  st: 'text-[#E6C98F]',
  fn: 'text-[#8DB4E8]',
  nu: 'text-[#F2B48C]',
  cm: 'text-[#7C8A7A]',
  tx: 'text-slate-100',
};

export function WorkspacePreview(): React.ReactElement {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-card border border-slate-800 bg-slate-900 shadow-pop"
    >
      {/* title bar */}
      <div className="flex h-10 items-center justify-between border-b border-slate-800 px-4">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
        </div>
        <span className="flex items-center gap-1.5 font-label text-[11px] text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> midnight-build
        </span>
        <div className="flex -space-x-1.5">
          {['#FF7139', '#8DB4E8', '#79C9A4'].map((c) => (
            <span key={c} className="h-5 w-5 rounded-full ring-2 ring-slate-900" style={{ background: c }} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 text-[11px] sm:grid-cols-[110px_1fr_150px]">
        {/* explorer */}
        <div className="hidden space-y-1 border-r border-slate-800 bg-slate-950/40 p-2.5 text-slate-400 sm:block">
          <div className="flex items-center gap-1.5 text-slate-300">
            <Folder size={12} /> src
          </div>
          <div className="flex items-center gap-1.5 rounded bg-ember-900 px-1.5 py-1 text-ember-300">
            <FileCode2 size={12} /> main.ts
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <FileCode2 size={12} /> server.ts
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <FileCode2 size={12} /> utils.ts
          </div>
        </div>

        {/* editor + terminal */}
        <div className="min-w-0 sm:border-r sm:border-slate-800">
          <div className="flex h-8 items-end border-b border-slate-800 px-2">
            <span className="border-b-2 border-ember-500 px-2 pb-1.5 font-label text-slate-100">
              main.ts
            </span>
            <span className="px-2 pb-1.5 font-label text-slate-500">server.ts</span>
          </div>
          <pre className="m-0 overflow-hidden p-3 font-mono text-[11.5px] leading-[1.75]">
            {LINES.map((line, i) => (
              <div key={i} className="flex">
                <span className="mr-3 w-3 select-none text-right text-slate-600">{i + 1}</span>
                <span className="relative whitespace-pre">
                  {line.map(([t, s], j) => (
                    <span key={j} className={TONE[t]}>
                      {s}
                    </span>
                  ))}
                  {i === 3 && (
                    <span className="absolute -top-0.5 left-0 flex items-center">
                      <span className="h-4 w-px bg-[#8DB4E8]" />
                      <span className="ml-0.5 rounded-sm bg-[#8DB4E8] px-1 text-[9px] font-medium text-slate-950">
                        Mira
                      </span>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </pre>
          <div className="border-t border-slate-800 bg-slate-950/70 p-2.5 font-mono text-[11px]">
            <div className="mb-1 flex items-center gap-1.5 font-label text-slate-500">
              <Terminal size={11} /> Terminal
            </div>
            <div className="text-slate-400">
              <span className="text-emerald-400">$</span> node main.ts
            </div>
            <div className="text-slate-300">listening on :3000</div>
          </div>
        </div>

        {/* assistant */}
        <div className="hidden space-y-2 bg-slate-950/40 p-2.5 sm:block">
          <div className="flex items-center gap-1.5 font-label text-slate-300">
            <Bot size={12} className="text-ember-500" /> AI Assistant
          </div>
          <p className="leading-relaxed text-slate-400">
            Added a health route and typed the handler.
          </p>
          <div className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5 font-label text-slate-500">
            Ask about this file…
          </div>
        </div>
      </div>
    </div>
  );
}

/** Unified diff renderer: red/green lines with the exact edited words highlighted. */
import type { DiffRow } from '../lib/diff.js';

const CONTEXT_LINES = 2;

/** Unified diff with long unchanged stretches collapsed. */
export function DiffView({ rows }: { rows: DiffRow[] }): React.ReactElement {
  const visible: Array<DiffRow | { skipped: number }> = [];
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === 'eq') return;
    for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(rows.length - 1, i + CONTEXT_LINES); k++) keep[k] = true;
  });
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) visible.push({ skipped });
      skipped = 0;
      visible.push(r);
    } else skipped++;
  });
  if (skipped) visible.push({ skipped });

  return (
    <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.5]">
      <div className="min-w-max">
        {visible.map((r, i) =>
          'skipped' in r ? (
            <div key={`s${i}`} className="px-2.5 py-0.5 text-center text-[10px] text-slate-600">
              ⋯ {r.skipped} unchanged line{r.skipped === 1 ? '' : 's'} ⋯
            </div>
          ) : (
            <div
              key={`${r.oldNo ?? ''}-${r.newNo ?? ''}-${r.kind}-${i}`}
              className={
                r.kind === 'add'
                  ? 'flex bg-emerald-500/10'
                  : r.kind === 'del'
                    ? 'flex bg-rose-500/10'
                    : 'flex'
              }
            >
              <span className="w-8 shrink-0 select-none pr-1 text-right text-slate-600">{r.oldNo ?? ''}</span>
              <span className="w-8 shrink-0 select-none pr-1 text-right text-slate-600">{r.newNo ?? ''}</span>
              <span
                className={`w-4 shrink-0 select-none text-center ${
                  r.kind === 'add' ? 'text-emerald-400' : r.kind === 'del' ? 'text-rose-400' : 'text-transparent'
                }`}
                aria-hidden
              >
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
              </span>
              <span className="whitespace-pre pr-3 text-slate-300">
                {r.segs.map((s, k) => (
                  <span
                    key={k}
                    className={
                      s.changed && r.kind === 'add'
                        ? 'rounded-sm bg-emerald-500/40 text-emerald-50'
                        : s.changed && r.kind === 'del'
                          ? 'rounded-sm bg-rose-500/40 text-rose-50'
                          : ''
                    }
                  >
                    {s.text}
                  </span>
                ))}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

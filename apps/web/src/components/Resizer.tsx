/**
 * Thin drag handle for resizing a neighbouring panel. Pointer-driven, keyboard
 * accessible (arrow keys), and clamped by the caller via min/max.
 */
import { useCallback, useRef } from 'react';

interface ResizerProps {
  /** 'x' resizes widths (vertical bar), 'y' resizes heights (horizontal bar). */
  axis: 'x' | 'y';
  /** Current size in px of the panel being resized. */
  size: number;
  min: number;
  max: number;
  /** True when growing the panel means dragging toward the origin (right/bottom panels). */
  invert?: boolean;
  onResize: (next: number) => void;
  label: string;
}

export function Resizer({
  axis,
  size,
  min,
  max,
  invert = false,
  onResize,
  label,
}: ResizerProps): React.ReactElement {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: axis === 'x' ? e.clientX : e.clientY, size };
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!start.current) return;
    const cur = axis === 'x' ? e.clientX : e.clientY;
    const delta = (cur - start.current.pos) * (invert ? -1 : 1);
    onResize(clamp(start.current.size + delta));
  };
  const end = (): void => {
    start.current = null;
    document.body.style.userSelect = '';
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const grow = axis === 'x' ? (invert ? 'ArrowLeft' : 'ArrowRight') : invert ? 'ArrowUp' : 'ArrowDown';
    const shrink = axis === 'x' ? (invert ? 'ArrowRight' : 'ArrowLeft') : invert ? 'ArrowDown' : 'ArrowUp';
    if (e.key === grow) onResize(clamp(size + 16));
    else if (e.key === shrink) onResize(clamp(size - 16));
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      className={`group relative z-10 shrink-0 ${
        axis === 'x' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      } bg-slate-800`}
    >
      {/* Wider invisible hit area; the 1px line itself turns ember on hover/focus. */}
      <span
        className={`absolute ${
          axis === 'x' ? '-left-1.5 -right-1.5 top-0 bottom-0' : '-top-1.5 -bottom-1.5 left-0 right-0'
        }`}
      />
      <span className="absolute inset-0 bg-slate-800 transition-colors group-hover:bg-ember-500 group-focus-visible:bg-ember-500" />
    </div>
  );
}

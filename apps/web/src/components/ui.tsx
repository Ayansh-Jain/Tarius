/**
 * Small shared UI primitives for the ICE design system.
 * Tokens live in tailwind.config.ts + index.css.
 */
import type { ReactNode } from 'react';

/** The ICE mark: two bars and a stem — an "I" with room to share. */
export function LogoMark({ size = 24 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#242424" />
      <path d="M10 10h12M10 22h12M16 10v12" stroke="#FF7139" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className = '' }: { className?: string }): React.ReactElement {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="font-display text-[17px] font-semibold tracking-tight text-slate-100">
        ICE
      </span>
    </span>
  );
}

interface TooltipProps {
  label: string;
  side?: 'right' | 'bottom' | 'top';
  children: ReactNode;
}

/** CSS-only tooltip: shows on hover and on keyboard focus of the child. */
export function Tooltip({ label, side = 'bottom', children }: TooltipProps): React.ReactElement {
  const pos =
    side === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2'
      : side === 'top'
        ? 'bottom-full left-1/2 mb-2 -translate-x-1/2'
        : 'top-full left-1/2 mt-2 -translate-x-1/2';
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-100 opacity-0 shadow-pop transition-opacity duration-150 group-hover/tt:opacity-100 group-has-[:focus-visible]/tt:opacity-100 ${pos}`}
      >
        {label}
      </span>
    </span>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tooltipSide?: TooltipProps['side'];
  children: ReactNode;
}

export function IconButton({
  label,
  active = false,
  tooltipSide = 'bottom',
  className = '',
  children,
  ...rest
}: IconButtonProps): React.ReactElement {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-control transition-colors duration-150 ${
          active
            ? 'bg-ember-900 text-ember-500'
            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
        } ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Tiny status dot + label (Live / Connecting / Offline). */
export function StatusDot({
  tone,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'error';
  pulse?: boolean;
}): React.ReactElement {
  const bg = tone === 'success' ? 'bg-emerald-400' : tone === 'warning' ? 'bg-amber-400' : 'bg-rose-400';
  return <span className={`h-1.5 w-1.5 rounded-full ${bg} ${pulse ? 'animate-pulse' : ''}`} />;
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="mt-1 text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

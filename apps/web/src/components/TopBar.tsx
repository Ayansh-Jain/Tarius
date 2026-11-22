/**
 * Room top bar: logo, room identity, live status, collaborators, voice, share.
 */
import { useState } from 'react';
import { Check, Link2, LogOut, Mic, PanelLeft } from 'lucide-react';
import type { ConnectionStatus, PresencePeer } from '../lib/connection.js';
import type { Participant } from '@ice/shared';
import type { AgentView } from '../lib/agentTypes.js';
import { Presence } from './Presence.js';
import { IconButton, LogoMark, StatusDot } from './ui.js';

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; tone: 'success' | 'warning' | 'error'; pulse: boolean }
> = {
  connected: { label: 'Live', tone: 'success', pulse: false },
  connecting: { label: 'Connecting…', tone: 'warning', pulse: true },
  offline: { label: 'Offline', tone: 'error', pulse: false },
};

interface TopBarProps {
  roomName: string;
  roomId: string;
  status: ConnectionStatus;
  peers: PresencePeer[];
  me: Participant;
  onEditIdentity: () => void;
  /** AI teammates in the room — shown in the presence strip as agent chips. */
  agents?: AgentView[];
  onOpenVoice?: () => void;
  voiceActive?: boolean;
  onLeave?: () => void;
  onToggleExplorer?: () => void;
}

export function TopBar({
  roomName,
  roomId,
  status,
  peers,
  me,
  onEditIdentity,
  agents = [],
  onOpenVoice,
  voiceActive = false,
  onLeave,
  onToggleExplorer,
}: TopBarProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const meta = STATUS_META[status];

  async function copyLink(): Promise<void> {
    const url = `${window.location.origin}/r/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can be blocked; fall back to a transient prompt.
      window.prompt('Copy this room link:', url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="sm:hidden">
          <IconButton label="Toggle files" onClick={() => onToggleExplorer?.()}>
            <PanelLeft size={18} />
          </IconButton>
        </span>
        <LogoMark size={26} />
        <span className="hidden h-5 w-px bg-slate-800 sm:block" />
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate font-display text-sm font-semibold tracking-tight text-slate-100">
            {roomName}
          </h1>
          <span className="hidden max-w-[9rem] truncate rounded-md bg-slate-800 px-1.5 py-0.5 font-label text-[10px] text-slate-400 lg:inline">
            {roomId}
          </span>
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-400"
            role="status"
            aria-live="polite"
          >
            <StatusDot tone={meta.tone} pulse={meta.pulse} />
            {meta.label}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Presence peers={peers} agents={agents} />

        <button
          type="button"
          onClick={onEditIdentity}
          className="hidden items-center gap-2 rounded-control border border-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-800 lg:inline-flex"
          aria-label="Change your name and color"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: me.color }} />
          <span className="max-w-[9rem] truncate">{me.name}</span>
        </button>

        <IconButton label="Voice" active={voiceActive} onClick={() => onOpenVoice?.()}>
          <Mic size={18} />
        </IconButton>

        <button
          type="button"
          onClick={() => void copyLink()}
          className="btn-primary !gap-1.5 !px-3 !py-1.5 !text-xs"
        >
          {copied ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
          {copied ? 'Link copied' : 'Invite'}
        </button>

        <IconButton label="Leave room" onClick={() => (onLeave ? onLeave() : window.location.assign("/"))}>
          <LogOut size={18} />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * ICE web — the real room experience (v0.1 Slice B).
 *
 * Routing is intentionally dependency-free: we read window.location and listen
 * for popstate. Two routes:
 *   '/'           → landing (pick identity, create a room)
 *   '/r/:roomId'  → the collaborative room (gated on having an identity)
 *
 * Opening the same /r/<id> URL in two browsers yields live shared editing with
 * named remote cursors — the v0.1 core demo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditOrigin, Participant } from '@ice/shared';
import {
  loadIdentity,
  saveIdentity,
  toParticipant,
  type StoredIdentity,
} from './lib/identity.js';
import { useRoomConnection } from './lib/connection.js';
import {
  Bot,
  Eye,
  FileCode2,
  Files,
  GitBranch,
  MessageSquare,
  Mic,
  Settings,
  ShieldCheck,
  TerminalSquare,
  X,
  type LucideIcon,
  Languages,
} from 'lucide-react';
import { Landing } from './components/Landing.js';
import { Home } from './components/Home.js';
import { StartPage } from './components/StartPage.js';
import { Resizer } from './components/Resizer.js';
import { IconButton, Tooltip } from './components/ui.js';
import { rememberRoom, roomNameFor } from './lib/rooms.js';
import { TopBar } from './components/TopBar.js';
import { FileTree } from './components/FileTree.js';
import { ApiStatusChip, ConvertDialog } from './components/ConvertDialog.js';
import { AssistantPanel } from './components/AssistantPanel.js';
import { TerminalPane } from './components/TerminalPane.js';
import { VoicePanel } from './components/VoicePanel.js';
import { releaseVoiceControllers } from './lib/voice.js';
import { ChatPanel } from './components/ChatPanel.js';
import { GitPanel } from './components/GitPanel.js';
import { PreviewPane } from './components/PreviewPane.js';
import { RollbackBar } from './components/RollbackBar.js';
import { SnapshotBar } from './components/SnapshotBar.js';
import { useFileTree } from './lib/useTree.js';
import { useAgents } from './lib/useAgents.js';
import { useAgentEdits } from './lib/useAgentEdits.js';
import { basename, resolveSelection } from './lib/tree.js';
import { Editor, DEFAULT_FILE } from './editor/Editor.js';

// ── Tiny router ───────────────────────────────────────────────────────────────

interface Route {
  kind: 'home' | 'start' | 'room';
  roomId?: string;
}

function parseRoute(pathname: string): Route {
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (match) return { kind: 'room', roomId: decodeURIComponent(match[1]!) };
  if (/^\/start\/?$/.test(pathname)) return { kind: 'start' };
  return { kind: 'home' };
}

function navigate(path: string): void {
  const [pathOnly, hash] = path.split('#');
  if (window.location.pathname !== pathOnly) {
    window.history.pushState({}, '', path);
    // pushState doesn't emit popstate; nudge listeners ourselves.
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo({ top: 0 });
  }
  if (hash) {
    window.requestAnimationFrame(() =>
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}

// ── App shell ─────────────────────────────────────────────────────────────────

export function App(): React.ReactElement {
  const route = useRoute();
  const [identity, setIdentity] = useState<StoredIdentity | null>(() => loadIdentity());

  const commitIdentity = useCallback((value: { name: string; color: string }): StoredIdentity => {
    const saved = saveIdentity(value);
    setIdentity(saved);
    return saved;
  }, []);

  // Join flow: we're already at /r/:id but have no identity yet.
  const handleJoin = useCallback(
    (value: { name: string; color: string }) => {
      commitIdentity(value);
    },
    [commitIdentity],
  );

  if (route.kind === 'home') return <Home onNavigate={navigate} />;
  if (route.kind === 'start') {
    return <StartPage initial={identity} onIdentity={commitIdentity} onNavigate={navigate} />;
  }

  // route.kind === 'room'
  const roomId = route.roomId!;
  if (!identity) {
    return (
      <Landing
        mode="join"
        initial={identity}
        joiningRoomId={roomId}
        onSubmit={handleJoin}
      />
    );
  }

  return <Room roomId={roomId} identity={identity} onChangeIdentity={commitIdentity} />;
}

// ── Room ──────────────────────────────────────────────────────────────────────

interface RoomProps {
  roomId: string;
  identity: StoredIdentity;
  onChangeIdentity: (value: { name: string; color: string }) => StoredIdentity;
}

// Which panel the right rail shows. Agents is the headline, so it's the default.
type RailTab = 'agents' | 'chat' | 'scm' | 'safety' | 'voice' | 'preview';

const RAIL_ITEMS: Array<{ tab: RailTab; label: string; icon: LucideIcon }> = [
  { tab: 'agents', label: 'AI Assistant', icon: Bot },
  { tab: 'chat', label: 'Chat', icon: MessageSquare },
  { tab: 'scm', label: 'Source control', icon: GitBranch },
  { tab: 'safety', label: 'Checkpoints', icon: ShieldCheck },
  { tab: 'voice', label: 'Voice', icon: Mic },
  { tab: 'preview', label: 'Preview', icon: Eye },
];

function FileIcon({ path }: { path: string }): React.ReactElement {
  const name = basename(path).toLowerCase();
  const tone = /\.(tsx?|mts)$/.test(name)
    ? 'text-[#8DB4E8]'
    : /\.(jsx?|mjs)$/.test(name)
      ? 'text-[#E6C98F]'
      : name.endsWith('.json')
        ? 'text-ember-400'
        : 'text-slate-400';
  return <FileCode2 size={14} className={`shrink-0 ${tone}`} aria-hidden />;
}

function Room({ roomId, identity, onChangeIdentity }: RoomProps): React.ReactElement {
  const participant: Participant = useMemo(() => toParticipant(identity), [identity]);
  const { connection, status, peers } = useRoomConnection(roomId, participant);
  // Leaving the room (unmount) ends any voice call that outlived its panel.
  useEffect(() => () => releaseVoiceControllers(), [roomId]);
  const [editingIdentity, setEditingIdentity] = useState(false);

  // Live CRDT file tree (seeds the default file on mount). Owned here so the
  // sidebar render list and the editor's selection reconciliation share one
  // subscription and never disagree.
  const nodes = useFileTree(connection);

  // Live agent roster (presence chips + count) and the most recent agent edit
  // (drives the "AI teammate is editing" indicator in the tab bar).
  const agents = useAgents(connection);
  const lastAgentEdit = useAgentEdits(connection);

  // The file the user picked. We bind the editor to a *resolved* path (below)
  // so a deleted or not-yet-existent selection can never make the editor
  // recreate a buffer.
  const [selected, setSelected] = useState<string>(DEFAULT_FILE);
  const boundPath = useMemo(
    () => resolveSelection(connection.doc, selected) ?? DEFAULT_FILE,
    // `nodes` is the live tree signal — recompute whenever it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection, selected, nodes],
  );

  // Layout state: explorer / right rail / terminal visibility + sizes.
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerW, setExplorerW] = useState(232);
  const [railOpen, setRailOpen] = useState(true);
  const [railW, setRailW] = useState(320);
  const [railTab, setRailTab] = useState<RailTab>('agents');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalH, setTerminalH] = useState(220);
  const [convertOpen, setConvertOpen] = useState(false);

  // Open editor tabs (paths). The bound file is always present.
  const [openTabs, setOpenTabs] = useState<string[]>([DEFAULT_FILE]);
  useEffect(() => {
    setOpenTabs((tabs) => (tabs.includes(boundPath) ? tabs : [...tabs, boundPath]));
  }, [boundPath]);
  const livePaths = useMemo(
    () => new Set(nodes.filter((n) => n.kind === 'file').map((n) => n.path)),
    [nodes],
  );
  const visibleTabs = useMemo(
    () => openTabs.filter((p) => p === boundPath || p === DEFAULT_FILE || livePaths.has(p)),
    [openTabs, livePaths, boundPath],
  );
  const closeTab = useCallback(
    (path: string) => {
      const idx = openTabs.indexOf(path);
      const next = openTabs.filter((p) => p !== path);
      if (path === boundPath) {
        setSelected(next[Math.min(idx, next.length - 1)] ?? DEFAULT_FILE);
      }
      setOpenTabs(next.length > 0 ? next : [DEFAULT_FILE]);
    },
    [openTabs, boundPath],
  );

  // Resolve the agent behind the last edit so we can label/color the indicator.
  const editingAgent = useMemo(
    () => (lastAgentEdit ? agents.find((a) => a.state.agentId === lastAgentEdit.agentId) : undefined),
    [agents, lastAgentEdit],
  );

  // The local human's attribution origin for all tree mutations.
  const origin: EditOrigin = useMemo(
    () => ({ kind: 'human', participantId: participant.id }),
    [participant.id],
  );

  // A fresh connection (room/identity change) resets to the default file.
  useEffect(() => {
    setSelected(DEFAULT_FILE);
    setOpenTabs([DEFAULT_FILE]);
  }, [connection]);

  // If the chosen file vanished (e.g. a peer deleted it), follow the resolved
  // fallback so the highlight and the editor stay in sync.
  useEffect(() => {
    if (selected !== boundPath) setSelected(boundPath);
  }, [boundPath, selected]);

  // Remember this room on this device (powers "Recent rooms").
  useEffect(() => {
    rememberRoom(roomId);
  }, [roomId]);

  const roomName = useMemo(() => roomNameFor(roomId) ?? `Room ${roomId}`, [roomId]);

  const openRail = (tab: RailTab): void => {
    if (railOpen && railTab === tab) setRailOpen(false);
    else {
      setRailTab(tab);
      setRailOpen(true);
    }
  };
  const railTitle = RAIL_ITEMS.find((r) => r.tab === railTab)?.label ?? '';

  return (
    <div className="page-enter flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <TopBar
        roomName={roomName}
        roomId={roomId}
        status={status}
        peers={peers}
        agents={agents}
        me={participant}
        onEditIdentity={() => setEditingIdentity(true)}
        onOpenVoice={() => openRail('voice')}
        voiceActive={railOpen && railTab === 'voice'}
        onLeave={() => navigate('/')}
        onToggleExplorer={() => setExplorerOpen((v) => !v)}
      />

      <div className="flex min-h-0 flex-1">
        {/* Activity bar */}
        <nav
          aria-label="Workspace"
          className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-slate-800 bg-slate-900 py-2"
        >
          <div className="flex flex-col items-center gap-1">
            <IconButton
              label="Files"
              tooltipSide="right"
              active={explorerOpen}
              onClick={() => setExplorerOpen((v) => !v)}
            >
              <Files size={18} />
            </IconButton>
            <span className="my-1 h-px w-5 bg-slate-800" />
            {RAIL_ITEMS.map(({ tab, label, icon: Icon }) => (
              <span key={tab} className="relative">
                <IconButton
                  label={label}
                  tooltipSide="right"
                  active={railOpen && railTab === tab}
                  onClick={() => openRail(tab)}
                >
                  <Icon size={18} />
                </IconButton>
                {tab === 'agents' && agents.length > 0 && (
                  <span className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ember-500 px-1 text-center text-[9px] font-semibold leading-4 text-slate-950">
                    {agents.length}
                  </span>
                )}
              </span>
            ))}
          </div>
          <div className="flex flex-col items-center gap-1">
            <IconButton
              label="Terminal"
              tooltipSide="right"
              active={terminalOpen}
              onClick={() => setTerminalOpen((v) => !v)}
            >
              <TerminalSquare size={18} />
            </IconButton>
            <IconButton
              label="Your identity"
              tooltipSide="right"
              onClick={() => setEditingIdentity(true)}
            >
              <Settings size={18} />
            </IconButton>
          </div>
        </nav>

        {/* File explorer */}
        {explorerOpen && (
          <>
            <aside
              style={{ width: explorerW }}
              className="hidden shrink-0 flex-col bg-slate-900/60 sm:flex"
              aria-label="File explorer"
            >
              <FileTree
                connection={connection}
                nodes={nodes}
                selected={boundPath}
                onSelect={setSelected}
                origin={origin}
              />
            </aside>
            <div className="hidden sm:block">
              <Resizer
                axis="x"
                size={explorerW}
                min={160}
                max={420}
                onResize={setExplorerW}
                label="Resize file explorer"
              />
            </div>
          </>
        )}

        {/* Editor (center) + bottom terminal */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Tab bar */}
          <div className="flex h-9 shrink-0 items-stretch justify-between gap-2 border-b border-slate-800 bg-slate-900">
            <div
              role="tablist"
              aria-label="Open files"
              className="flex min-w-0 items-stretch overflow-x-auto"
            >
              {visibleTabs.map((p) => {
                const active = p === boundPath;
                return (
                  <div
                    key={p}
                    className={`group relative flex shrink-0 items-center gap-2 border-r border-slate-800 pl-3 pr-1.5 text-xs transition-colors ${
                      active
                        ? 'bg-slate-950 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setSelected(p)}
                      title={p}
                      className="flex items-center gap-2 py-2"
                    >
                      <FileIcon path={p} />
                      <span className="max-w-[10rem] truncate">{basename(p)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${basename(p)}`}
                      onClick={() => closeTab(p)}
                      className="rounded p-0.5 text-slate-500 opacity-0 transition-opacity hover:bg-slate-800 hover:text-slate-100 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                    {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-ember-500" />}
                  </div>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-2 pr-2">
              <ApiStatusChip />
              <button
                type="button"
                onClick={() => setConvertOpen(true)}
                title="Convert this file to another language"
                className="inline-flex items-center gap-1.5 rounded-control border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
              >
                <Languages size={13} aria-hidden /> Convert
              </button>
            </div>
            {/* "AI teammate is editing" / last-edit attribution indicator. */}
            {lastAgentEdit && editingAgent && (
              <span
                className="mr-3 hidden shrink-0 items-center gap-1.5 self-center rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium md:inline-flex"
                style={{ color: editingAgent.state.color }}
                title={
                  lastAgentEdit.path
                    ? `${editingAgent.state.displayName} ${lastAgentEdit.active ? 'is editing' : 'last edited'} ${lastAgentEdit.path}`
                    : `${editingAgent.state.displayName} ${lastAgentEdit.active ? 'is editing' : 'edited'}`
                }
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${lastAgentEdit.active ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: editingAgent.state.color }}
                />
                {editingAgent.state.displayName} {lastAgentEdit.active ? 'is editing…' : 'edited'}
              </span>
            )}
          </div>

          {convertOpen && (
            <ConvertDialog
              connection={connection}
              path={boundPath}
              origin={origin}
              onClose={() => setConvertOpen(false)}
              onOpenFile={setSelected}
            />
          )}

          <div className="min-h-0 flex-1 bg-slate-950">
            <Editor connection={connection} path={boundPath} />
          </div>

          {/* Terminal panel (bottom, collapsible + resizable) */}
          {terminalOpen && (
            <>
              <Resizer
                axis="y"
                size={terminalH}
                min={120}
                max={560}
                invert
                onResize={setTerminalH}
                label="Resize terminal"
              />
              <section
                style={{ height: terminalH }}
                className="flex shrink-0 flex-col bg-[#101010]"
                aria-label="Terminal"
              >
                <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-800 px-3">
                  <span className="flex items-center gap-2 font-label text-[11px] text-slate-400">
                    <TerminalSquare size={13} aria-hidden /> Terminal
                  </span>
                  <Tooltip label="Close terminal">
                    <button
                      type="button"
                      aria-label="Close terminal"
                      onClick={() => setTerminalOpen(false)}
                      className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
                    >
                      <X size={14} />
                    </button>
                  </Tooltip>
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalPane connection={connection} roomId={roomId} />
                </div>
              </section>
            </>
          )}
        </main>

        {/* Right rail */}
        {railOpen && (
          <>
            <div className="hidden md:block">
              <Resizer
                axis="x"
                size={railW}
                min={260}
                max={560}
                invert
                onResize={setRailW}
                label="Resize side panel"
              />
            </div>
            <aside
              style={{ width: railW }}
              className="hidden shrink-0 flex-col bg-slate-900/60 md:flex"
              aria-label={railTitle}
            >
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800 px-3">
                <h2 className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
                  {railTitle}
                </h2>
                <button
                  type="button"
                  aria-label="Close panel"
                  onClick={() => setRailOpen(false)}
                  className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
                >
                  <X size={14} />
                </button>
              </div>
              <div key={railTab} className="min-h-0 flex-1 animate-fade-in">
                {railTab === 'agents' && (
                  <AssistantPanel roomId={roomId} connection={connection} activePath={boundPath} origin={origin} />
                )}
                {railTab === 'chat' && <ChatPanel connection={connection} me={participant} />}
                {railTab === 'scm' && <GitPanel roomId={roomId} connection={connection} />}
                {railTab === 'safety' && (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="shrink-0 p-3">
                      <RollbackBar roomId={roomId} connection={connection} />
                    </div>
                    <div className="min-h-0 flex-1 border-t border-slate-800">
                      <SnapshotBar roomId={roomId} connection={connection} me={participant} />
                    </div>
                  </div>
                )}
                {railTab === 'voice' && (
                  <VoicePanel roomId={roomId} identity={participant.id} name={participant.name} />
                )}
                {railTab === 'preview' && <PreviewPane roomId={roomId} connection={connection} />}
              </div>
            </aside>
          </>
        )}
      </div>

      {editingIdentity && (
        <Landing
          mode="edit"
          initial={identity}
          onSubmit={(value) => {
            onChangeIdentity(value);
            setEditingIdentity(false);
          }}
          onCancel={() => setEditingIdentity(false)}
        />
      )}
    </div>
  );
}

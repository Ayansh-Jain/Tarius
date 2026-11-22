/**
 * Marketing homepage (route '/'). Presentational only: every CTA hands off to
 * the real create/join flow at '/start'.
 */
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  FilePlus2,
  Files,
  Link2,
  Mic,
  TerminalSquare,
  Users,
} from 'lucide-react';
import { Logo } from './ui.js';
import { WorkspacePreview } from './WorkspacePreview.js';

interface HomeProps {
  onNavigate: (path: string) => void;
}

const FEATURES = [
  {
    icon: Users,
    title: 'Real-Time Collaboration',
    body: 'Code together with synchronized changes and shared project context.',
  },
  {
    icon: Files,
    title: 'Multi-File Workspace',
    body: 'Create, edit, and organize files within one workspace.',
  },
  {
    icon: TerminalSquare,
    title: 'Integrated Terminal',
    body: 'Run commands and execute supported code directly.',
  },
  {
    icon: Bot,
    title: 'AI Coding Assistant',
    body: 'Get help understanding, debugging, and improving code.',
  },
  {
    icon: Mic,
    title: 'Voice Collaboration',
    body: 'Discuss ideas with other people in the room.',
  },
  {
    icon: Link2,
    title: 'Instant Room Sharing',
    body: 'Create a room and invite others using a shareable link or room code.',
  },
] as const;

const STEPS = [
  { n: '01', title: 'Create a room', body: 'Set up a coding session in seconds.' },
  { n: '02', title: 'Invite your people', body: 'Share the room and collaborate in real time.' },
  {
    n: '03',
    title: 'Build together',
    body: 'Write code, run programs, discuss problems, and work with your AI assistant.',
  },
] as const;

function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function Home({ onNavigate }: HomeProps): React.ReactElement {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navLink =
    'rounded-md px-3 py-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ── Navigation ─────────────────────────────────────────────────── */}
      <header
        className={`fixed inset-x-0 top-0 z-40 transition-colors duration-200 ${
          scrolled ? 'border-b border-slate-800 bg-slate-950/85 backdrop-blur' : 'border-b border-transparent'
        }`}
      >
        <nav
          aria-label="Primary"
          className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5"
        >
          <a href="/" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <Logo />
          </a>
          <div className="hidden items-center gap-1 md:flex">
            <button type="button" className={navLink} onClick={() => scrollToId('features')}>
              Features
            </button>
            <button type="button" className={navLink} onClick={() => scrollToId('how-it-works')}>
              How It Works
            </button>
            <button type="button" className={navLink} onClick={() => onNavigate('/start')}>
              Join Room
            </button>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('/start')}
            className="btn-primary !px-3.5 !py-2"
          >
            Create Room
          </button>
        </nav>
      </header>

      <main>
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="glow-ember relative overflow-hidden pt-32">
          <div className="bg-dots pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-24 lg:grid-cols-[1fr_1.1fr]">
            <div className="page-enter">
              <p className="eyebrow mb-5">Collaborative coding workspace</p>
              <h1 className="font-display text-5xl font-semibold leading-[1.04] tracking-[-0.035em] text-slate-100 sm:text-6xl">
                Code better.
                <br />
                <span className="text-ember-500">Together.</span>
              </h1>
              <p className="mt-6 max-w-md text-base leading-relaxed text-slate-400">
                A collaborative coding workspace where your team can write, run, and build together
                in real time, with an AI teammate alongside you.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <button type="button" className="btn-primary" onClick={() => onNavigate('/start')}>
                  Start Coding
                  <ArrowRight size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onNavigate('/start#join')}
                >
                  Join a Room
                </button>
                <button
                  type="button"
                  className="rounded-control px-3 py-2.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
                  onClick={() => scrollToId('features')}
                >
                  Explore Features
                </button>
              </div>
            </div>

            <div className="page-enter [animation-delay:120ms]">
              <WorkspacePreview />
            </div>
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────────────── */}
        <section id="features" className="scroll-mt-20 border-t border-slate-800/70 py-24">
          <div className="mx-auto max-w-6xl px-5">
            <p className="eyebrow mb-3">Features</p>
            <h2 className="max-w-lg font-display text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
              Everything a team needs in one shared room.
            </h2>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li
                  key={title}
                  className="group rounded-card border border-slate-800 bg-slate-900 p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-700 hover:bg-[#202020]"
                >
                  <span className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-control bg-slate-800 text-slate-300 transition-colors group-hover:bg-ember-900 group-hover:text-ember-500">
                    <Icon size={20} strokeWidth={1.75} aria-hidden />
                  </span>
                  <h3 className="font-display text-[17px] font-semibold tracking-tight">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────── */}
        <section id="how-it-works" className="scroll-mt-20 border-t border-slate-800/70 py-24">
          <div className="mx-auto max-w-6xl px-5">
            <p className="eyebrow mb-3">How it works</p>
            <h2 className="max-w-lg font-display text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
              From idea to shared session in three steps.
            </h2>
            <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-0">
              {STEPS.map((s, i) => (
                <li key={s.n} className="relative md:pr-10">
                  {i < STEPS.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute left-12 right-4 top-[15px] hidden h-px bg-slate-800 md:block"
                    />
                  )}
                  <span className="relative inline-flex rounded-full bg-slate-950 pr-3 font-label text-sm font-medium text-ember-500">
                    {s.n}
                  </span>
                  <h3 className="mt-5 font-display text-xl font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-slate-400">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Final CTA ────────────────────────────────────────────────── */}
        <section className="border-t border-slate-800/70 py-24">
          <div className="mx-auto max-w-3xl px-5 text-center">
            <h2 className="font-display text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
              Your next great idea starts in a room.
            </h2>
            <p className="mt-4 text-slate-400">Bring your team together and start building.</p>
            <button
              type="button"
              className="btn-primary mt-9 !px-6 !py-3"
              onClick={() => onNavigate('/start')}
            >
              <FilePlus2 size={16} aria-hidden />
              Create Your Room
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-800/70 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 text-xs text-slate-500">
          <Logo />
          <span>Open source · Apache-2.0 · Self-hostable</span>
        </div>
      </footer>
    </div>
  );
}

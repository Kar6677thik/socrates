import { StrictMode, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Link, useLocation } from 'wouter';
import './styles.css';
import { api, qc, useApi, type Home, type Session } from './lib/api';
import { isTyping } from './lib/keys';
import { Toaster, Kbd, Modal } from './components/ui';
import { Palette } from './components/Palette';
import HomePage from './pages/Home';
import StudyPage from './pages/Study';
import SignIn from './pages/SignIn';

const Library = lazy(() => import('./pages/Library'));
const Editor = lazy(() => import('./pages/Editor'));
const Review = lazy(() => import('./pages/Review'));
const Grades = lazy(() => import('./pages/Grades'));
const Tags = lazy(() => import('./pages/Tags'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Import = lazy(() => import('./pages/Import'));

const NAV: { href: string; label: string; key: string; badge?: (h: Home) => number }[] = [
  { href: '/', label: 'Home', key: 'h' },
  { href: '/study', label: 'Study', key: 's' },
  { href: '/analytics', label: 'Analytics', key: 'y' },
  { href: '/library', label: 'Library', key: 'l' },
  { href: '/review', label: 'Drafts', key: 'd', badge: (h) => h.counts.drafts },
  { href: '/grades', label: 'Grading', key: 'g', badge: (h) => h.counts.pending },
  { href: '/tags', label: 'Tags', key: 't' },
  { href: '/activity', label: 'Agent activity', key: 'a' },
  { href: '/settings', label: 'Settings', key: ',' },
];

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch {}
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

function Shell({ children }: { children: ReactNode }) {
  const [loc, nav] = useLocation();
  const { data: home } = useApi<Home>('/home', { refetchInterval: 30_000 });
  const { data: session } = useApi<Session>('/session');
  const signOut = async () => {
    await api.del('/session').catch(() => {});
    qc.clear();
    qc.setQueryData<Session>(['/session'], { signedIn: false, loginRequired: true });
  };
  const [theme, toggleTheme] = useTheme();
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const chord = useRef(0);
  const focusMode = /^\/study\/\d+/.test(loc);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !focusMode) {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (Date.now() - chord.current < 900) {
        const item = NAV.find((n) => n.key === e.key);
        chord.current = 0;
        if (item) { e.preventDefault(); nav(item.href); }
        return;
      }
      if (focusMode) return;
      if (e.key === 'g') chord.current = Date.now();
      else if (e.key === '?') setHelp(true);
      else if (e.key === '\\') toggleTheme();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, focusMode, toggleTheme]);

  if (focusMode) return <>{children}</>;

  return (
    <div className="flex h-full">
      <aside className="w-[212px] shrink-0 border-r border-line flex flex-col py-4 px-3 max-md:hidden">
        <Link href="/" className="flex items-center gap-2 px-2 mb-6">
          <span className="w-6 h-6 rounded-md bg-elev border border-line-strong grid place-items-center font-serif text-[13px]">S</span>
          <span className="font-semibold tracking-[-0.01em]">Socrates</span>
        </Link>
        <button onClick={() => setPalette(true)} className="flex items-center justify-between h-8 px-2 mb-3 rounded-md border border-line text-[13px] text-faint hover:text-text hover:border-line-strong">
          <span>Search or run…</span>
          <span className="flex gap-0.5"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
        </button>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = n.href === '/' ? loc === '/' : loc.startsWith(n.href);
            const badge = home && n.badge ? n.badge(home) : 0;
            return (
              <Link key={n.href} href={n.href} className={`group flex items-center justify-between h-8 px-2 rounded-md text-[13.5px] transition-colors ${active ? 'bg-elev text-text' : 'text-muted hover:text-text hover:bg-hover'}`}>
                <span>{n.label}</span>
                <span className="flex items-center gap-1.5">
                  {badge > 0 && <span className="text-[11px] text-accent tabular-nums">{badge}</span>}
                  <span className="text-[10.5px] font-mono text-faint opacity-0 group-hover:opacity-100">g {n.key}</span>
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center justify-between px-2 text-faint text-[12px]">
          <button onClick={() => setHelp(true)} className="hover:text-text">Shortcuts <Kbd>?</Kbd></button>
          <span className="flex gap-3">
            {session?.loginRequired && <button onClick={signOut} className="hover:text-text">Sign out</button>}
            <button onClick={toggleTheme} className="hover:text-text" title="Toggle theme (\)">{theme === 'dark' ? 'Light' : 'Dark'}</button>
          </span>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto">
        <nav className="md:hidden sticky top-0 z-30 flex items-center gap-1 px-3 h-12 border-b border-line bg-bg/95 backdrop-blur overflow-x-auto">
          <Link href="/" className="w-6 h-6 shrink-0 mr-1 rounded-md bg-elev border border-line-strong grid place-items-center font-serif text-[13px]">S</Link>
          <button onClick={() => setPalette(true)} className="shrink-0 h-8 px-2.5 rounded-md border border-line text-[13px] text-faint">Search</button>
          {NAV.map((n) => {
            const active = n.href === '/' ? loc === '/' : loc.startsWith(n.href);
            const badge = home && n.badge ? n.badge(home) : 0;
            return (
              <Link key={n.href} href={n.href} className={`shrink-0 h-8 px-2.5 rounded-md text-[13px] flex items-center gap-1.5 ${active ? 'bg-elev text-text' : 'text-muted'}`}>
                {n.label.replace('Agent activity', 'Activity')}
                {badge > 0 && <span className="text-[11px] text-accent tabular-nums">{badge}</span>}
              </Link>
            );
          })}
          <button onClick={toggleTheme} className="shrink-0 h-8 px-2.5 text-[13px] text-faint">{theme === 'dark' ? 'Light' : 'Dark'}</button>
        </nav>
        <div className="max-w-[1040px] mx-auto px-8 py-8 max-md:px-4">{children}</div>
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} toggleTheme={toggleTheme} />
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" wide>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 text-[13px]">
          {[
            ['Command palette', 'Ctrl+K'], ['Go to page', 'g then h s y l d g t a ,'], ['Toggle theme', '\\'], ['Start recommended session (home)', 'Enter'],
            ['Search library', '/'], ['New question (library)', 'n'],
            ['— While studying —', ''], ['Pick option', '1–9'], ['True / false', 't  f'], ['Submit / next', 'Enter'],
            ['Submit written answer', 'Ctrl+Enter'], ['Reveal flashcard', 'Space'], ['Rate flashcard', '1–4'],
            ['Confidence', 'q w e r  (Alt+1–4 while typing)'], ['Hint', 'h  (Alt+H)'], ['Flag question', 'x'], ['Skip', 's'], ['Undo last answer', 'z'], ['Open in library', 'o'], ['Leave session', 'Esc'],
            ['Matching: assign / move row', '1–9  /  ↑ ↓'], ['Ordering: pick / move item', '↑ ↓  /  Alt+↑ ↓'], ['Code: run tests / submit', "Ctrl+'  /  Ctrl+Enter"],
            ['— Exam —', ''], ['Previous / next', '← →'], ['Mark for review', 'm'], ['Submit exam', 'Ctrl+Enter'],
            ['— Drafts —', ''], ['Approve / reject', 'a  /  x'], ['Next / previous', 'j  /  k'], ['Edit', 'e'],
          ].map(([a, b], i) => (
            <div key={i} className={`flex justify-between py-1 ${b ? 'border-b border-line' : 'text-faint pt-3'}`}>
              <span className={b ? 'text-muted' : ''}>{a}</span>
              <span className="font-mono text-[12px]">{b}</span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Deployed instances need the owner signed in; locally loginRequired is false and this renders straight through. */
function App() {
  const { data: session, isError } = useApi<Session>('/session');
  if (!session && !isError) return null;
  if (session?.loginRequired && !session.signedIn) return <SignIn />;
  return <Routes />;
}

function Routes() {
  return (
    <Shell>
      <Suspense fallback={null}>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/study">{() => <StudyPage />}</Route>
          <Route path="/study/:id">{(p) => <StudyPage sessionId={Number(p.id)} />}</Route>
          <Route path="/library" component={Library} />
          <Route path="/library/new">{() => <Editor />}</Route>
          <Route path="/library/:id">{(p) => <Editor id={Number(p.id)} />}</Route>
          <Route path="/review" component={Review} />
          <Route path="/grades" component={Grades} />
          <Route path="/tags" component={Tags} />
          <Route path="/activity" component={Activity} />
          <Route path="/settings" component={Settings} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/import" component={Import} />
          <Route><div className="text-muted">Not found.</div></Route>
        </Switch>
      </Suspense>
    </Shell>
  );
}

// Installable app + instant reloads (production build only; Vite's dev server handles its own caching).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);

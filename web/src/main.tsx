import { StrictMode, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Link, useLocation } from 'wouter';
import './styles.css';
import { qc, useApi, type Home } from './lib/api';
import { isTyping } from './lib/keys';
import { Toaster, Kbd, Modal } from './components/ui';
import HomePage from './pages/Home';
import StudyPage from './pages/Study';

const Library = lazy(() => import('./pages/Library'));
const Editor = lazy(() => import('./pages/Editor'));
const Review = lazy(() => import('./pages/Review'));
const Grades = lazy(() => import('./pages/Grades'));
const Tags = lazy(() => import('./pages/Tags'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));

const NAV: { href: string; label: string; key: string; badge?: (h: Home) => number }[] = [
  { href: '/', label: 'Home', key: 'h' },
  { href: '/study', label: 'Study', key: 's' },
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
  const [theme, toggleTheme] = useTheme();
  const [help, setHelp] = useState(false);
  const chord = useRef(0);
  const focusMode = /^\/study\/\d+/.test(loc);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
          <button onClick={toggleTheme} className="hover:text-text" title="Toggle theme (\)">{theme === 'dark' ? 'Light' : 'Dark'}</button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[1040px] mx-auto px-8 py-8 max-md:px-4">{children}</div>
      </main>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" wide>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 text-[13px]">
          {[
            ['Go to page', 'g then h s l d g t a ,'], ['Toggle theme', '\\'], ['Start recommended session (home)', 'Enter'],
            ['Search library', '/'], ['New question (library)', 'n'],
            ['— While studying —', ''], ['Pick option', '1–9'], ['True / false', 't  f'], ['Submit / next', 'Enter'],
            ['Submit written answer', 'Ctrl+Enter'], ['Reveal flashcard', 'Space'], ['Rate flashcard', '1–4'],
            ['Confidence', 'q w e r  (Alt+1–4 while typing)'], ['Hint', 'h  (Alt+H)'], ['Flag question', 'x'], ['Skip', 's'], ['Edit question', 'e'], ['Leave session', 'Esc'],
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

function App() {
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
          <Route><div className="text-muted">Not found.</div></Route>
        </Switch>
      </Suspense>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);

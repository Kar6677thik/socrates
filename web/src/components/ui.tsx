import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from './store';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary', size = 'md', kbd, className = '', children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; kbd?: string }) {
  const v: Record<Variant, string> = {
    primary: 'bg-accent text-accent-ink hover:opacity-90 border-transparent',
    secondary: 'bg-panel border-line hover:border-line-strong hover:bg-hover',
    ghost: 'border-transparent text-muted hover:text-text hover:bg-hover',
    danger: 'bg-panel border-line text-bad hover:border-bad/50 hover:bg-bad-soft',
  };
  const s = { sm: 'h-7 px-2.5 text-[12.5px] gap-1.5', md: 'h-8 px-3 text-[13px] gap-2', lg: 'h-10 px-4 text-sm gap-2.5' }[size];
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-lg border font-medium transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none select-none whitespace-nowrap ${v[variant]} ${s} ${className}`}
    >
      {children}
      {kbd && <Kbd onAccent={variant === 'primary'}>{kbd}</Kbd>}
    </button>
  );
}

export function Kbd({ children, className = '', onAccent }: { children: ReactNode; className?: string; onAccent?: boolean }) {
  const tone = onAccent ? 'border-[color-mix(in_oklab,var(--accent-ink)_30%,transparent)] text-[color-mix(in_oklab,var(--accent-ink)_75%,transparent)]' : 'border-line bg-elev text-muted';
  return (
    <kbd className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border font-mono text-[10.5px] leading-none ${tone} ${className}`}>
      {children}
    </kbd>
  );
}

export function Chip({ children, active, onClick, className = '' }: { children: ReactNode; active?: boolean; onClick?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2.5 rounded-md border text-[12.5px] transition-colors ${active ? 'border-accent/60 bg-accent-soft text-text' : 'border-line text-muted hover:text-text hover:border-line-strong'} ${className}`}
    >
      {children}
    </button>
  );
}

export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return <span title={title} className="inline-flex items-center h-5 px-1.5 rounded bg-elev text-[11.5px] text-muted whitespace-nowrap">{children}</span>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'bad' | 'warn' }) {
  const t = { neutral: 'bg-elev text-muted', accent: 'bg-accent-soft text-accent', good: 'bg-good-soft text-good', bad: 'bg-bad-soft text-bad', warn: 'bg-elev text-warn' }[tone];
  return <span className={`inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium ${t}`}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-panel ${className}`}>{children}</div>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">{title}</h1>
        {sub && <div className="text-muted mt-0.5">{sub}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border border-dashed border-line rounded-xl py-14 px-6 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="text-muted mt-1.5 max-w-md mx-auto">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="text-[12.5px] font-medium text-muted mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[12px] text-faint mt-1">{hint}</div>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg border border-line bg-panel">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-7 px-3 rounded-md text-[13px] transition-colors ${value === o.value ? 'bg-elev text-text shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-text'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`fade-in w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-xl border border-line-strong bg-panel max-h-[80vh] overflow-auto`}>
        <div className="flex items-center justify-between px-5 h-12 border-b border-line">
          <div className="font-medium">{title}</div>
          <button onClick={onClose} className="text-faint hover:text-text text-lg leading-none" aria-label="Close">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------- Toasts ----------

type Toast = { id: number; text: string; tone: 'neutral' | 'bad' | 'good'; action?: { label: string; run: () => void } };
const toasts = create<Toast[]>([]);
let tid = 0;
export function toast(text: string, tone: Toast['tone'] = 'neutral', action?: Toast['action']) {
  const id = ++tid;
  toasts.set((t) => [...t.slice(-3), { id, text, tone, action }]);
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3200);
}
export function Toaster() {
  const items = toasts.use();
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 items-end pointer-events-none">
      {items.map((t) => (
        <div key={t.id} className={`fade-in pointer-events-auto flex items-center gap-3 rounded-lg border bg-elev px-3.5 py-2 text-[13px] max-w-sm ${t.tone === 'bad' ? 'border-bad/40' : 'border-line-strong'}`}>
          <span className={t.tone === 'bad' ? 'text-bad' : t.tone === 'good' ? 'text-good' : ''}>{t.text}</span>
          {t.action && <button className="text-accent font-medium" onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 150): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CopyBox({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <div className="group relative">
      {label && <div className="text-[12.5px] text-muted mb-1">{label}</div>}
      <pre className="font-mono text-[12px] bg-elev border border-line rounded-lg px-3 py-2.5 pr-16 overflow-x-auto whitespace-pre">{text}</pre>
      <button
        className="absolute right-2 bottom-2 h-6 px-2 rounded border border-line bg-panel text-[11.5px] text-muted hover:text-text"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(t.current);
          t.current = setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const APP_NAMES: Record<string, string> = { slate: 'Slate', sprawl: 'Sprawl', socrates: 'Socrates', 'hey-ann': 'Hey Ann', ann: 'Hey Ann' };

/** "From Slate: Raft consensus", linked when the source has a web address; plus a free-text citation. */
export function SourceLine({ source, citation, className = '' }: { source?: { app: string; id: string; url?: string; title?: string } | null; citation?: string | null; className?: string }) {
  if (!source && !citation) return null;
  const app = source ? APP_NAMES[source.app] ?? source.app : '';
  const label = source ? source.title || source.id : '';
  // Only http(s) links are rendered as links (never javascript: or data: from stored content).
  const href = source?.url && /^https?:\/\//i.test(source.url) ? source.url : null;
  return (
    <div className={`text-[12.5px] text-faint ${className}`}>
      {source && (
        <span>
          From {app}:{' '}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-text">{label}</a>
          ) : (
            <span className="text-muted">{label}</span>
          )}
        </span>
      )}
      {source && citation && <span> · </span>}
      {citation && <span>{citation}</span>}
    </div>
  );
}

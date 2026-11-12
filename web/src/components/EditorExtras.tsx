import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Button, Field, toast } from './ui';
import { TestResults } from './answers';

const CodeEditor = lazy(() => import('./CodeEditor'));

/** Upload an image file; returns its /media URL. */
export async function uploadImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Only images can be uploaded.');
  const data = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
  return (await api.post<{ url: string }>('/media', { data })).url;
}

/** Markdown textarea that accepts pasted or dropped images (uploaded, then inserted as ![](url)). */
export function PromptField({ value, onChange, rows = 5, mono = true }: { value: string; onChange: (v: string) => void; rows?: number; mono?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const insert = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return false;
    setBusy(true);
    try {
      const urls = await Promise.all(imgs.map(uploadImage));
      const el = ref.current!;
      const at = el.selectionStart ?? value.length;
      const text = urls.map((u) => `![](${u})`).join('\n');
      onChange(value.slice(0, at) + text + value.slice(el.selectionEnd ?? at));
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
    return true;
  };
  return (
    <div className="relative">
      <textarea
        ref={ref}
        className={`field ${mono ? 'font-mono text-[13px]' : ''} ${over ? 'border-accent' : ''}`}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); insert(files); } }}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { setOver(false); const files = [...e.dataTransfer.files]; if (files.length) { e.preventDefault(); insert(files); } }}
      />
      {busy && <div className="absolute right-3 bottom-3 text-[12px] text-faint">Uploading…</div>}
    </div>
  );
}

const Remove = ({ onClick, disabled, label = 'Remove' }: { onClick: () => void; disabled?: boolean; label?: string }) => (
  <button type="button" className="text-faint hover:text-text disabled:opacity-30 px-1 shrink-0" onClick={onClick} disabled={disabled} aria-label={label}>×</button>
);

export function MatchingForm({ s, spec }: { s: any; spec: (p: any) => void }) {
  const pairs: { left: string; right: string }[] = s.pairs;
  const distractors: string[] = s.distractors ?? [];
  const setPair = (i: number, k: 'left' | 'right', v: string) => { const p = [...pairs]; p[i] = { ...p[i], [k]: v }; spec({ pairs: p }); };
  return (
    <>
      <Field label="Pairs" hint="Each left item matches the right item on its row. Right items are shuffled when shown.">
        <div className="space-y-2">
          {pairs.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="field" value={p.left} placeholder="Left" onChange={(e) => setPair(i, 'left', e.target.value)} />
              <span className="text-faint">→</span>
              <input className="field" value={p.right} placeholder="Right" onChange={(e) => setPair(i, 'right', e.target.value)} />
              <Remove disabled={pairs.length <= 2} onClick={() => spec({ pairs: pairs.filter((_, j) => j !== i) })} />
            </div>
          ))}
          {pairs.length < 12 && <Button size="sm" variant="ghost" onClick={() => spec({ pairs: [...pairs, { left: '', right: '' }] })}>Add pair</Button>}
        </div>
      </Field>
      <Field label="Distractors" hint="Optional right-hand items that match nothing.">
        <div className="space-y-2">
          {distractors.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="field" value={d} onChange={(e) => { const v = [...distractors]; v[i] = e.target.value; spec({ distractors: v }); }} />
              <Remove onClick={() => spec({ distractors: distractors.filter((_, j) => j !== i) })} />
            </div>
          ))}
          {distractors.length < 6 && <Button size="sm" variant="ghost" onClick={() => spec({ distractors: [...distractors, ''] })}>Add distractor</Button>}
        </div>
      </Field>
    </>
  );
}

export function OrderingForm({ s, spec }: { s: any; spec: (p: any) => void }) {
  const items: string[] = s.items;
  const move = (i: number, j: number) => { if (j < 0 || j >= items.length) return; const v = [...items]; [v[i], v[j]] = [v[j], v[i]]; spec({ items: v }); };
  return (
    <Field label="Items in the correct order" hint="Shown shuffled. Partial credit counts how many pairs are in the right relative order.">
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 text-right text-faint tabular-nums text-[13px]">{i + 1}</span>
            <input className="field" value={it} onChange={(e) => { const v = [...items]; v[i] = e.target.value; spec({ items: v }); }} />
            <button type="button" className="w-6 h-6 rounded text-faint hover:text-text hover:bg-hover" onClick={() => move(i, i - 1)} aria-label="Move up">↑</button>
            <button type="button" className="w-6 h-6 rounded text-faint hover:text-text hover:bg-hover" onClick={() => move(i, i + 1)} aria-label="Move down">↓</button>
            <Remove disabled={items.length <= 3} onClick={() => spec({ items: items.filter((_, j) => j !== i) })} />
          </div>
        ))}
        {items.length < 12 && <Button size="sm" variant="ghost" onClick={() => spec({ items: [...items, ''] })}>Add item</Button>}
      </div>
    </Field>
  );
}

export const ClozeHelp = () => (
  <div className="text-[12.5px] text-muted rounded-lg border border-line px-3 py-2.5 leading-relaxed">
    Write the answers inside the question: <code className="font-mono text-text">{'{{c1::Paris}}'}</code>. Alternatives with <code className="font-mono text-text">|</code>, a hint after <code className="font-mono text-text">::</code>, e.g. <code className="font-mono text-text">{'{{c2::H2O|water::formula}}'}</code>.
  </div>
);

/** One test row; keeps its own text so half-typed JSON is not lost. */
function TestRow({ t, onChange, onRemove }: { t: any; onChange: (t: any) => void; onRemove: () => void }) {
  const [args, setArgs] = useState(JSON.stringify(t.args ?? []));
  const [expected, setExpected] = useState(JSON.stringify(t.expected ?? null));
  const parse = (s: string) => { try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false, v: null }; } };
  const a = parse(args), e = parse(expected);
  const argsOk = a.ok && Array.isArray(a.v);
  return (
    <div className="flex items-center gap-2">
      <input className={`field font-mono text-[12.5px] ${argsOk ? '' : 'border-bad/60'}`} value={args} placeholder="[1, 2]" title="Arguments as a JSON array"
        onChange={(ev) => { setArgs(ev.target.value); const p = parse(ev.target.value); if (p.ok && Array.isArray(p.v)) onChange({ ...t, args: p.v }); }} />
      <span className="text-faint">→</span>
      <input className={`field font-mono text-[12.5px] ${e.ok ? '' : 'border-bad/60'}`} value={expected} placeholder="3" title="Expected return value (JSON)"
        onChange={(ev) => { setExpected(ev.target.value); const p = parse(ev.target.value); if (p.ok) onChange({ ...t, expected: p.v }); }} />
      <label className="flex items-center gap-1 text-[12px] text-muted whitespace-nowrap"><input type="checkbox" checked={!!t.hidden} onChange={(ev) => onChange({ ...t, hidden: ev.target.checked || undefined })} /> hidden</label>
      <Remove onClick={onRemove} />
    </div>
  );
}

export function CodeForm({ s, spec }: { s: any; spec: (p: any) => void }) {
  const isJs = /^(js|javascript)$/i.test(s.language ?? '');
  const tests: any[] = s.tests ?? [];
  const [check, setCheck] = useState<any>(null);
  const [keyN, setKeyN] = useState(0);
  const runCheck = async () => {
    try { setCheck(await api.post('/code/check', { code: s.reference_solution ?? '', tests, function_name: s.function_name })); }
    catch (e: any) { toast(e.message, 'bad'); }
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Language">
          <select className="field h-9" value={s.language} onChange={(e) => spec({ language: e.target.value })}>
            {['javascript', 'typescript', 'python', 'java', 'cpp', 'go', 'rust', 'sql'].map((l) => <option key={l}>{l}</option>)}
          </select>
        </Field>
        {isJs && <Field label="Function name"><input className="field h-9 font-mono" value={s.function_name ?? ''} placeholder="solution" onChange={(e) => spec({ function_name: e.target.value || undefined })} /></Field>}
      </div>
      <Field label="Starter code" hint="Shown in the editor when the question opens.">
        <Suspense fallback={<div className="h-[120px]" />}><CodeEditor value={s.starter ?? ''} onChange={(v) => spec({ starter: v || undefined })} language={s.language} minHeight={100} /></Suspense>
      </Field>
      {isJs && (
        <Field label="Tests" hint="Auto-graded. Arguments as a JSON array, expected value as JSON. Hidden tests are only revealed as pass/fail.">
          <div className="space-y-2" key={keyN}>
            {tests.map((t, i) => (
              <TestRow key={i} t={t} onChange={(nt) => { const v = [...tests]; v[i] = nt; spec({ tests: v }); }} onRemove={() => { spec({ tests: tests.filter((_, j) => j !== i) }); setKeyN((k) => k + 1); }} />
            ))}
            <Button size="sm" variant="ghost" onClick={() => spec({ tests: [...tests, { args: [], expected: null }] })}>Add test</Button>
          </div>
        </Field>
      )}
      <Field label="Reference solution" hint={isJs ? 'Optional. Use “Check” to confirm your tests pass against it.' : 'Required without tests: the grader compares answers against it.'}>
        <Suspense fallback={<div className="h-[120px]" />}><CodeEditor value={s.reference_solution ?? ''} onChange={(v) => spec({ reference_solution: v || undefined })} language={s.language} minHeight={100} /></Suspense>
        {isJs && tests.length > 0 && s.reference_solution && (
          <div className="mt-2">
            <Button size="sm" onClick={runCheck}>Check tests against reference</Button>
            {check && <TestResults r={check} />}
          </div>
        )}
      </Field>
    </>
  );
}

interface Region { x: number; y: number; w: number; h: number; label?: string }

export function HotspotForm({ s, spec }: { s: any; spec: (p: any) => void }) {
  const regions: Region[] = s.regions ?? [];
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const rel = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const norm = (d: NonNullable<typeof drag>): Region => ({
    x: +Math.min(d.x0, d.x1).toFixed(4), y: +Math.min(d.y0, d.y1).toFixed(4), w: +Math.abs(d.x1 - d.x0).toFixed(4), h: +Math.abs(d.y1 - d.y0).toFixed(4),
  });
  const pick = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try { spec({ image: await uploadImage(f) }); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const rect = (r: Region, i: number | null, children?: ReactNode) => (
    <div key={i ?? 'draft'} className="absolute border-2 rounded" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
      {children}
    </div>
  );
  return (
    <>
      <Field label="Image" hint="Upload, paste a /media URL, or an https link.">
        <div className="flex gap-2">
          <input className="field h-9" value={s.image ?? ''} placeholder="/media/… or https://…" onChange={(e) => spec({ image: e.target.value })} />
          <label className="inline-flex items-center h-9 px-3 rounded-lg border border-line bg-panel hover:border-line-strong text-[13px] cursor-pointer whitespace-nowrap">
            {busy ? 'Uploading…' : 'Upload'}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        </div>
      </Field>
      {s.image && (
        <Field label="Correct regions" hint="Drag on the image to draw a region. A click inside any region counts as correct.">
          <div
            ref={box}
            className="relative inline-block max-w-full rounded-lg overflow-hidden border border-line select-none cursor-crosshair"
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const p = rel(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
            onPointerMove={(e) => { if (drag) { const p = rel(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
            onPointerUp={() => {
              if (drag) { const r = norm(drag); if (r.w > 0.01 && r.h > 0.01 && regions.length < 5) spec({ regions: [...regions, r] }); }
              setDrag(null);
            }}
          >
            <img src={s.image} alt="" draggable={false} className="block max-w-full max-h-[50vh]" />
            {regions.map((r, i) => rect(r, i, <span className="absolute -top-0 left-0.5 text-[11px] font-medium" style={{ color: 'var(--accent)' }}>{i + 1}</span>))}
            {drag && rect(norm(drag), null)}
          </div>
          {regions.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {regions.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-5 text-faint text-right">{i + 1}</span>
                  <input className="field h-8" value={r.label ?? ''} placeholder="Label (optional)" onChange={(e) => { const v = [...regions]; v[i] = { ...r, label: e.target.value || undefined }; spec({ regions: v }); }} />
                  <span className="text-faint font-mono whitespace-nowrap">{Math.round(r.w * 100)}×{Math.round(r.h * 100)}%</span>
                  <Remove onClick={() => spec({ regions: regions.filter((_, j) => j !== i) })} />
                </div>
              ))}
            </div>
          )}
        </Field>
      )}
    </>
  );
}

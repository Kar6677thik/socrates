import { lazy, Suspense, useRef, useState, type MutableRefObject } from 'react';
import { api, type PublicQuestion, type SubmitResult } from '../lib/api';
import { Md } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Kbd, Button, toast } from './ui';

const CodeEditor = lazy(() => import('./CodeEditor'));

/**
 * Shared answer handling for every question type, used by the study runner and the exam runner:
 * state shape, completeness, the response sent to the server, keyboard bindings, and the input
 * with its post-answer feedback.
 */

export interface Answer {
  choice: number | null;
  choices: number[];
  tf: boolean | null;
  blanks: string[];
  text: string;
  map: (number | null)[];
  order: number[];
  moved: boolean;
  code: string;
  point: { x: number; y: number } | null;
  cursor: number;
}

/** Stable per-question shuffle (seeded by id + salt) so re-renders and revisits keep the order. */
export function shuffleFor(id: number, n: number, salt = 0): number[] {
  let seed = (id * 2654435761 + salt * 97 + new Date().getDate()) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Display orders: MCQ options and matching rights (indices into the original arrays). */
export function displayOrder(q: PublicQuestion) {
  const n = q.spec.options?.length ?? 0;
  return {
    options: q.spec.shuffle === false ? [...Array(n).keys()] : shuffleFor(q.id, n),
    rights: shuffleFor(q.id, q.spec.rights?.length ?? 0, 1),
  };
}

export function emptyAnswer(q: PublicQuestion): Answer {
  let order: number[] = [];
  if (q.type === 'ordering') {
    const n = q.spec.items.length;
    order = shuffleFor(q.id, n, 2);
    if (order.every((v, i) => v === i)) order = [...order.slice(1), order[0]]; // never start solved
  }
  return {
    choice: null, choices: [], tf: null, text: '', moved: false, cursor: 0, point: null, order,
    blanks: Array(q.spec.blanks ?? 0).fill(''),
    map: Array(q.spec.lefts?.length ?? 0).fill(null),
    code: q.spec.starter ?? '',
  };
}

export function hasAnswer(q: PublicQuestion, a: Answer): boolean {
  switch (q.type) {
    case 'mcq_single': return a.choice !== null;
    case 'mcq_multi': return a.choices.length > 0;
    case 'true_false': return a.tf !== null;
    case 'fill_blank':
    case 'cloze': return a.blanks.some((b) => b.trim());
    case 'numeric':
    case 'short_answer': return a.text.trim() !== '';
    case 'matching': return a.map.some((m) => m !== null);
    case 'ordering': return a.moved;
    case 'code': return a.code.trim() !== '' && a.code.trim() !== (q.spec.starter ?? '').trim();
    case 'hotspot': return a.point !== null;
    case 'flashcard': return true;
  }
}

export function toResponse(q: PublicQuestion, a: Answer): unknown {
  switch (q.type) {
    case 'mcq_single': return { choice: a.choice };
    case 'mcq_multi': return { choices: a.choices };
    case 'true_false': return { value: a.tf };
    case 'fill_blank':
    case 'cloze': return { blanks: a.blanks };
    case 'numeric': return { value: a.text };
    case 'short_answer': return { text: a.text };
    case 'matching': return { map: a.map };
    case 'ordering': return { order: a.order };
    case 'code': return { code: a.code };
    case 'hotspot': return { x: a.point?.x ?? null, y: a.point?.y ?? null };
    case 'flashcard': return {};
  }
}

/** Types whose answer is typed into a field (the runner focuses it and Enter shouldn't submit for multi-line ones). */
export const TEXT_TYPES = new Set(['fill_blank', 'cloze', 'numeric', 'short_answer']);
export const MULTILINE = new Set(['short_answer', 'code']);

/** Prompt with fill-in blanks numbered (⟦n⟧ renders as a numbered slot). */
export function numberBlanks(prompt: string) {
  let n = 0;
  return prompt.replace(/\{\{\s*blank\s*\}\}/g, () => `⟦${++n}⟧`);
}

export type SetAnswer = (patch: Partial<Answer>, kind?: string, data?: unknown) => void;

/** Keyboard bindings for answering (digits, t/f, arrows). Runner-level keys are layered on top. */
export function answerKeys(q: PublicQuestion, a: Answer, set: SetAnswer, locked: boolean): Record<string, (e: KeyboardEvent) => unknown> {
  if (locked) return {};
  const ord = displayOrder(q);
  const k: Record<string, (e: KeyboardEvent) => unknown> = {};
  if (q.type === 'mcq_single' || q.type === 'mcq_multi') {
    for (let i = 1; i <= Math.min(9, ord.options.length); i++)
      k[String(i)] = () => {
        const orig = ord.options[i - 1];
        if (q.type === 'mcq_single') set({ choice: orig }, 'change', orig);
        else set({ choices: a.choices.includes(orig) ? a.choices.filter((x) => x !== orig) : [...a.choices, orig] }, 'change', orig);
      };
  }
  if (q.type === 'true_false') {
    k['1'] = k.t = () => set({ tf: true }, 'change', true);
    k['2'] = k.f = () => set({ tf: false }, 'change', false);
  }
  if (q.type === 'matching') {
    const rows = a.map.length;
    for (let i = 1; i <= Math.min(9, ord.rights.length); i++)
      k[String(i)] = () => set({ ...assign(a, a.cursor, ord.rights[i - 1]), cursor: Math.min(rows - 1, a.cursor + 1) }, 'change', [a.cursor, ord.rights[i - 1]]);
    k.ArrowDown = () => set({ cursor: Math.min(rows - 1, a.cursor + 1) });
    k.ArrowUp = () => set({ cursor: Math.max(0, a.cursor - 1) });
    k.Backspace = () => { const map = [...a.map]; map[a.cursor] = null; set({ map }, 'change', [a.cursor, null]); };
  }
  if (q.type === 'ordering') {
    const n = a.order.length;
    k.ArrowDown = () => set({ cursor: Math.min(n - 1, a.cursor + 1) });
    k.ArrowUp = () => set({ cursor: Math.max(0, a.cursor - 1) });
    k['alt+ArrowDown'] = () => move(a, set, a.cursor, a.cursor + 1);
    k['alt+ArrowUp'] = () => move(a, set, a.cursor, a.cursor - 1);
  }
  return k;
}

/** Assign right item r to left row i; a right can only be used once, so it is cleared elsewhere. */
function assign(a: Answer, i: number, r: number): Partial<Answer> {
  const map = a.map.map((m) => (m === r ? null : m));
  map[i] = r;
  return { map };
}

function move(a: Answer, set: SetAnswer, from: number, to: number) {
  if (to < 0 || to >= a.order.length || from === to) return;
  const order = [...a.order];
  const [x] = order.splice(from, 1);
  order.splice(to, 0, x);
  set({ order, cursor: to, moved: true }, 'change', [from, to]);
}

const tone = (state: 'idle' | 'chosen' | 'right' | 'wrong' | 'dim') =>
  ({
    idle: 'border-line hover:border-line-strong hover:bg-hover',
    chosen: 'border-accent/70 bg-accent-soft',
    right: 'border-good/60 bg-good-soft',
    wrong: 'border-bad/60 bg-bad-soft',
    dim: 'border-line opacity-60',
  })[state];

/**
 * The answer input for any type. With `result`, it shows the correct answer inline.
 * `reveal` is the flashcard back-side toggle. `firstField` receives the first text field for focusing.
 */
export function AnswerInput({ q, a, set, result, locked, firstField, revealed }: {
  q: PublicQuestion; a: Answer; set: SetAnswer; result?: SubmitResult | null; locked?: boolean;
  firstField?: MutableRefObject<any>; revealed?: boolean;
}) {
  const ord = displayOrder(q);
  const done = !!result || !!locked;

  switch (q.type) {
    case 'mcq_single':
    case 'mcq_multi': {
      const right = new Set<number>(result ? (q.type === 'mcq_single' ? [result.answer.correct] : result.answer.correct) : []);
      const chosen = new Set(q.type === 'mcq_single' ? (a.choice !== null ? [a.choice] : []) : a.choices);
      return (
        <div className="flex flex-col gap-2">
          {q.type === 'mcq_multi' && !result && <div className="text-[12.5px] text-faint mb-1">Select {q.spec.count === 1 ? 'one' : `all that apply (${q.spec.count})`}</div>}
          {ord.options.map((orig, i) => {
            const st = result ? (right.has(orig) ? 'right' : chosen.has(orig) ? 'wrong' : 'dim') : chosen.has(orig) ? 'chosen' : 'idle';
            return (
              <button
                key={orig}
                disabled={done}
                onClick={() => (q.type === 'mcq_single' ? set({ choice: orig }, 'change', orig) : set({ choices: a.choices.includes(orig) ? a.choices.filter((x) => x !== orig) : [...a.choices, orig] }, 'change', orig))}
                className={`flex items-start gap-3 text-left rounded-xl border px-4 py-3 transition-colors duration-100 ${tone(st)}`}
              >
                <Kbd className="mt-[3px] shrink-0">{i + 1}</Kbd>
                <Md src={q.spec.options[orig]} className="flex-1" />
                {result && right.has(orig) && <span className="text-good text-[12px] mt-0.5">correct</span>}
                {result && chosen.has(orig) && !right.has(orig) && <span className="text-bad text-[12px] mt-0.5">your answer</span>}
              </button>
            );
          })}
        </div>
      );
    }

    case 'true_false':
      return (
        <div className="grid grid-cols-2 gap-3">
          {[true, false].map((v, i) => {
            const st = result ? (result.answer.correct === v ? 'right' : a.tf === v ? 'wrong' : 'dim') : a.tf === v ? 'chosen' : 'idle';
            return (
              <button key={String(v)} disabled={done} onClick={() => set({ tf: v }, 'change', v)} className={`h-14 rounded-xl border flex items-center justify-center gap-3 text-[15px] transition-colors ${tone(st)}`}>
                <Kbd>{i + 1}</Kbd> {v ? 'True' : 'False'} <span className="text-faint text-[12px]">({v ? 't' : 'f'})</span>
              </button>
            );
          })}
        </div>
      );

    case 'fill_blank':
    case 'cloze': {
      const accept = (i: number) => (q.type === 'cloze' ? result?.answer.blanks?.[i]?.accept?.[0] : result?.detail?.accept?.[i]);
      return (
        <div className="flex flex-col gap-2.5">
          {a.blanks.map((b, i) => {
            const ok = result?.detail?.blanks?.[i];
            return (
              <div key={i} className="flex items-center gap-3 flex-wrap">
                <span className="w-5 text-right text-faint tabular-nums text-[13px]">{i + 1}</span>
                <input
                  ref={i === 0 ? firstField : undefined}
                  value={b}
                  disabled={done}
                  aria-label={`Blank ${i + 1}`}
                  onChange={(e) => { const v = [...a.blanks]; v[i] = e.target.value; set({ blanks: v }, 'type'); }}
                  className={`field max-w-sm ${result ? (ok ? 'border-good/60' : 'border-bad/60') : ''}`}
                />
                {result && !ok && accept(i) && <span className="text-[13px] text-muted">→ <span className="text-text">{accept(i)}</span></span>}
              </div>
            );
          })}
        </div>
      );
    }

    case 'numeric':
      return (
        <div className="flex items-center gap-3 flex-wrap">
          <input
            ref={firstField}
            value={a.text}
            disabled={done}
            inputMode="decimal"
            placeholder="Your answer"
            onChange={(e) => set({ text: e.target.value }, 'type')}
            className={`field max-w-[240px] font-mono ${result ? (result.correct ? 'border-good/60' : 'border-bad/60') : ''}`}
          />
          {q.spec.unit && <span className="text-muted">{q.spec.unit}</span>}
          {result && !result.correct && (
            <span className="text-[13px] text-muted">→ <span className="text-text font-mono">{result.answer.answer}</span>{result.answer.tolerance ? <span className="text-faint"> (±{result.answer.relative ? `${result.answer.tolerance * 100}%` : result.answer.tolerance})</span> : null}</span>
          )}
        </div>
      );

    case 'short_answer':
      return (
        <div>
          <textarea
            ref={firstField}
            value={a.text}
            disabled={done}
            rows={q.spec.long ? 12 : 5}
            placeholder="Write your answer…  (Ctrl+Enter to submit)"
            onChange={(e) => set({ text: e.target.value }, 'type')}
            className="field text-[14.5px]"
          />
          {!result && q.spec.rubric?.length > 0 && <div className="mt-2 text-[12.5px] text-faint">Graded on: {q.spec.rubric.map((r: any) => `${r.criterion} (${r.points})`).join(' · ')}</div>}
        </div>
      );

    case 'flashcard':
      return revealed ? <div className="border-t border-line pt-6 fade-in"><Md src={q.spec.back} /></div> : null;

    case 'matching':
      return <Matching q={q} a={a} set={set} result={result} done={done} rights={ord.rights} />;

    case 'ordering':
      return <Ordering q={q} a={a} set={set} result={result} done={done} />;

    case 'hotspot':
      return <Hotspot q={q} a={a} set={set} result={result} done={done} />;

    case 'code':
      return <CodeAnswer q={q} a={a} set={set} result={result} done={done} />;
  }
}

function Matching({ q, a, set, result, done, rights }: { q: PublicQuestion; a: Answer; set: SetAnswer; result?: SubmitResult | null; done: boolean; rights: number[] }) {
  const pos = new Map(rights.map((r, i) => [r, i + 1]));
  return (
    <div className="grid grid-cols-[1fr_1fr] gap-6 max-sm:grid-cols-1">
      <div className="flex flex-col gap-2">
        {q.spec.lefts.map((l: string, i: number) => {
          const m = a.map[i];
          const ok = result?.detail?.pairs?.[i];
          const st = result ? (ok ? 'right' : 'wrong') : !done && a.cursor === i ? 'chosen' : 'idle';
          return (
            <button key={i} disabled={done} onClick={() => set({ cursor: i })} className={`flex items-center gap-3 text-left rounded-xl border px-4 py-2.5 min-h-12 transition-colors ${tone(st)}`}>
              <Md src={l} className="flex-1 text-[14px]" />
              <span className={`shrink-0 max-w-[45%] text-[13px] ${m === null ? 'text-faint' : ''}`}>
                {m === null ? '—' : <span className="inline-flex items-center gap-1.5"><Kbd>{pos.get(m)}</Kbd><Md src={q.spec.rights[m]} inline className="inline" /></span>}
              </span>
              {result && !ok && <span className="text-[12px] text-muted shrink-0 max-w-[30%]">→ <Md src={q.spec.rights[i]} inline className="inline text-text" /></span>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        {!done && <div className="text-[12px] text-faint -mb-0.5">Pick a row, then a match ({rights.length <= 9 ? 'or press its number' : 'click'}). ↑/↓ move rows.</div>}
        {rights.map((r, i) => {
          const used = a.map.includes(r);
          return (
            <button
              key={r}
              disabled={done}
              onClick={() => set({ ...assign(a, a.cursor, r), cursor: Math.min(a.map.length - 1, a.cursor + 1) }, 'change', [a.cursor, r])}
              className={`flex items-start gap-3 text-left rounded-xl border px-4 py-2.5 transition-colors ${done ? 'border-line' : used ? 'border-line opacity-50 hover:opacity-100' : tone('idle')}`}
            >
              <Kbd className="mt-[2px] shrink-0">{i + 1}</Kbd>
              <Md src={q.spec.rights[r]} className="flex-1 text-[14px]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Ordering({ q, a, set, result, done }: { q: PublicQuestion; a: Answer; set: SetAnswer; result?: SubmitResult | null; done: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <div>
      {!done && <div className="text-[12.5px] text-faint mb-2">Drag, or use ↑/↓ to pick and Alt+↑/↓ to move.</div>}
      <ol className="flex flex-col gap-2">
        {a.order.map((item, i) => {
          const ok = result?.detail?.positions?.[i];
          const st = result ? (ok ? 'right' : 'wrong') : !done && a.cursor === i ? 'chosen' : 'idle';
          return (
            <li
              key={item}
              draggable={!done}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (drag !== null) move(a, set, drag, i); setDrag(null); }}
              onClick={() => !done && set({ cursor: i })}
              className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 transition-colors ${done ? '' : 'cursor-grab active:cursor-grabbing'} ${drag === i ? 'opacity-40' : ''} ${tone(st)}`}
            >
              <span className="w-5 text-right text-faint tabular-nums text-[13px]">{i + 1}</span>
              <Md src={q.spec.items[item]} className="flex-1 text-[14px]" />
              {!done && (
                <span className="flex gap-0.5">
                  <button aria-label="Move up" className="w-6 h-6 rounded text-faint hover:text-text hover:bg-hover" onClick={(e) => { e.stopPropagation(); move(a, set, i, i - 1); }}>↑</button>
                  <button aria-label="Move down" className="w-6 h-6 rounded text-faint hover:text-text hover:bg-hover" onClick={(e) => { e.stopPropagation(); move(a, set, i, i + 1); }}>↓</button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {result && !result.correct && (
        <div className="mt-4 text-[13px]">
          <div className="text-faint mb-1">Correct order</div>
          <ol className="list-decimal pl-5 text-muted space-y-0.5">{q.spec.items.map((it: string, i: number) => <li key={i}><Md src={it} inline /></li>)}</ol>
        </div>
      )}
    </div>
  );
}

function Hotspot({ q, a, set, result, done }: { q: PublicQuestion; a: Answer; set: SetAnswer; result?: SubmitResult | null; done: boolean }) {
  const regions: { x: number; y: number; w: number; h: number; label?: string }[] = result?.answer?.regions ?? [];
  return (
    <div>
      {!done && <div className="text-[12.5px] text-faint mb-2">Click the spot on the image.</div>}
      <div
        className={`relative inline-block max-w-full rounded-lg overflow-hidden border border-line select-none ${done ? '' : 'cursor-crosshair'}`}
        onClick={(e) => {
          if (done) return;
          const r = e.currentTarget.getBoundingClientRect();
          set({ point: { x: +((e.clientX - r.left) / r.width).toFixed(4), y: +((e.clientY - r.top) / r.height).toFixed(4) } }, 'change');
        }}
      >
        <img src={q.spec.image} alt="" draggable={false} className="block max-w-full max-h-[60vh]" />
        {regions.map((g, i) => (
          <div key={i} className="absolute border-2 rounded" style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%`, borderColor: 'var(--good)', background: 'var(--good-soft)' }} title={g.label} />
        ))}
        {a.point && (
          <div
            className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2"
            style={{ left: `${a.point.x * 100}%`, top: `${a.point.y * 100}%`, borderColor: 'var(--panel)', background: result ? (result.correct ? 'var(--good)' : 'var(--bad)') : 'var(--accent)' }}
          />
        )}
      </div>
    </div>
  );
}

interface RunResult { results: { pass: boolean; hidden?: boolean; args?: unknown[]; expected?: unknown; actual?: string; error?: string; ms: number }[]; passed: number; total: number; error?: string; logs: string[] }

export function TestResults({ r }: { r: RunResult }) {
  return (
    <div className="mt-3 rounded-lg border border-line text-[12.5px] overflow-hidden">
      <div className={`px-3 py-2 flex justify-between ${r.passed === r.total ? 'text-good' : 'text-bad'}`}>
        <span>{r.passed} / {r.total} tests passed</span>
        {r.error && <span className="text-muted truncate ml-3">{r.error}</span>}
      </div>
      {r.results.map((t, i) => (
        <div key={i} className="px-3 py-1.5 border-t border-line font-mono text-[12px] flex gap-3">
          <span className={t.pass ? 'text-good' : 'text-bad'}>{t.pass ? 'pass' : 'fail'}</span>
          {t.hidden ? (
            <span className="text-faint">hidden test</span>
          ) : (
            <span className="text-muted min-w-0 truncate">
              ({(t.args ?? []).map((x) => JSON.stringify(x)).join(', ')}) → {t.error ? <span className="text-bad">{t.error}</span> : t.actual}
              {!t.pass && !t.error && <span className="text-faint"> · expected {JSON.stringify(t.expected)}</span>}
            </span>
          )}
        </div>
      ))}
      {r.logs.length > 0 && <pre className="px-3 py-2 border-t border-line text-[11.5px] text-muted whitespace-pre-wrap">{r.logs.join('\n')}</pre>}
    </div>
  );
}

function CodeAnswer({ q, a, set, result, done }: { q: PublicQuestion; a: Answer; set: SetAnswer; result?: SubmitResult | null; done: boolean }) {
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const runTests = async () => {
    if (!q.spec.auto || busyRef.current || done) return;
    busyRef.current = true;
    setBusy(true);
    try { setRun(await api.post<RunResult>('/code/run', { question_id: q.id, code: a.code })); }
    catch (e: any) { toast(e.message, 'bad'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useKeys({ "mod+'": runTests }, { allowInInput: ["mod+'"] });
  const visible = (q.spec.tests ?? []).filter((t: any) => !t.hidden);
  const hidden = (q.spec.tests ?? []).length - visible.length;
  return (
    <div>
      <div className="flex items-center justify-between text-[12px] text-faint mb-1.5">
        <span className="font-mono">{q.spec.language}{q.spec.auto ? ` · define ${q.spec.function_name}()` : ''}</span>
        <span>{q.spec.auto ? `${visible.length} visible test${visible.length === 1 ? '' : 's'}${hidden ? ` + ${hidden} hidden` : ''}` : 'graded against a reference solution'}</span>
      </div>
      <Suspense fallback={<div className="h-[180px] rounded-[10px] border border-line bg-[var(--code-bg)]" />}>
        <CodeEditor value={a.code} onChange={(v) => set({ code: v }, 'type')} language={q.spec.language} readOnly={done} autoFocus={!done} />
      </Suspense>
      {!done && q.spec.auto && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={runTests} disabled={busy} kbd="Ctrl '">{busy ? 'Running…' : 'Run tests'}</Button>
          <span className="text-[12px] text-faint">Ctrl+Enter submits</span>
        </div>
      )}
      {!result && run && <TestResults r={run} />}
      {result?.detail?.results && <TestResults r={result.detail} />}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, useApi, invalidate, pct, fmtMs, fmtDue, tagLabel, useTagNames, TYPES, TYPE_LABELS, type PublicQuestion, type SubmitResult, type QType, type Home } from '../lib/api';
import { Md } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Button, Chip, Kbd, Segmented, Field, Modal, toast, Card } from '../components/ui';
import { TagInput } from '../components/TagInput';
import { startSession } from './Home';

export default function StudyPage({ sessionId }: { sessionId?: number }) {
  return sessionId ? <Runner key={sessionId} sessionId={sessionId} /> : <Builder />;
}

// ---------------------------------------------------------------- Builder

function Builder() {
  const [, nav] = useLocation();
  const { data: h } = useApi<Home>('/home');
  const [mode, setMode] = useState<'srs' | 'practice'>('srs');
  const [tags, setTags] = useState<string[]>([]);
  const [types, setTypes] = useState<QType[]>([]);
  const [diff, setDiff] = useState<number[]>([]);
  const [limit, setLimit] = useState(20);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const go = () =>
    startSession(nav, {
      mode,
      tags: tags.length ? tags : undefined,
      types: types.length ? types : undefined,
      difficulty: diff.length ? [Math.min(...diff), Math.max(...diff)] : undefined,
      limit: mode === 'practice' ? limit : undefined,
    });
  useKeys({ 'mod+Enter': go, Enter: go });

  return (
    <div className="max-w-2xl fade-in">
      <h1 className="text-[19px] font-semibold tracking-[-0.01em] mb-6">New session</h1>
      <div className="space-y-6">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'srs', label: `Spaced review${h ? ` · ${h.due + h.new_available}` : ''}` },
            { value: 'practice', label: 'Practice' },
          ]}
        />
        <p className="text-muted -mt-3 text-[13px]">
          {mode === 'srs'
            ? 'Questions due today, lowest recall first, plus new questions within your daily limit. Answers update the review schedule.'
            : 'A sample weighted toward questions you get wrong and ones you have not seen. Answers still update the schedule.'}
        </p>
        <Field label="Tags" hint="Includes all subtags. Leave empty for everything.">
          <TagInput value={tags} onChange={setTags} placeholder="All tags" allowCreate={false} />
        </Field>
        <Field label="Question types">
          <div className="flex flex-wrap gap-1.5">
            {TYPES.map((t) => <Chip key={t} active={types.includes(t)} onClick={() => setTypes(toggle(types, t))}>{TYPE_LABELS[t]}</Chip>)}
          </div>
        </Field>
        <Field label="Difficulty">
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((d) => <Chip key={d} active={diff.includes(d)} onClick={() => setDiff(toggle(diff, d))}>{d}</Chip>)}
          </div>
        </Field>
        {mode === 'practice' && (
          <Field label="Questions">
            <div className="flex gap-1.5">
              {[10, 20, 40, 80].map((n) => <Chip key={n} active={limit === n} onClick={() => setLimit(n)}>{n}</Chip>)}
            </div>
          </Field>
        )}
        <Button variant="primary" size="lg" kbd="↵" onClick={go}>Start</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Runner

const CONF = [
  { v: 1, label: 'Guess', key: 'q' },
  { v: 2, label: 'Unsure', key: 'w' },
  { v: 3, label: 'Likely', key: 'e' },
  { v: 4, label: 'Sure', key: 'r' },
];
const SELF = [
  { score: 0, label: 'Wrong' },
  { score: 0.5, label: 'Partly' },
  { score: 0.8, label: 'Mostly' },
  { score: 1, label: 'Fully' },
];
const FLASH = [
  { r: 1, label: 'Again' },
  { r: 2, label: 'Hard' },
  { r: 3, label: 'Good' },
  { r: 4, label: 'Easy' },
];

interface Done {
  q: PublicQuestion;
  result: SubmitResult;
  time_ms: number;
}

function numberBlanks(prompt: string) {
  let n = 0;
  return prompt.replace(/\{\{\s*blank\s*\}\}/g, () => `⟦${++n}⟧`);
}

function shuffleFor(id: number, n: number): number[] {
  // Stable per-question shuffle (seeded by id + day) so re-renders don't reorder options.
  let seed = (id * 2654435761 + new Date().getDate()) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function Runner({ sessionId }: { sessionId: number }) {
  const [, nav] = useLocation();
  const { data, error } = useApi<{ session_id: number; questions: PublicQuestion[]; answered: number }>(`/sessions/${sessionId}`);
  const [queue, setQueue] = useState<PublicQuestion[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (data && !queue) setQueue(data.questions);
  }, [data, queue]);

  const finish = useCallback(async () => {
    setFinished(true);
    api.post(`/sessions/${sessionId}/end`).catch(() => {});
    invalidate('/home', '/grades', '/questions');
  }, [sessionId]);

  if (error) return <div className="p-10 text-muted">{(error as Error).message}</div>;
  if (!queue) return null;
  if (finished || idx >= queue.length) return <Summary done={done} onFinish={finish} finished={finished} />;

  const q = queue[idx];
  return (
    <Question
      key={`${q.id}-${idx}`}
      q={q}
      sessionId={sessionId}
      position={idx}
      total={queue.length}
      onDone={(d) => { setDone((x) => [...x, d]); setIdx((i) => i + 1); }}
      onSkip={() => { setQueue((qs) => [...qs!, qs![idx]]); setIdx((i) => i + 1); }}
      onDrop={() => { setQueue((qs) => qs!.filter((_, i) => i !== idx)); }}
      onExit={() => (done.length ? finish() : nav('/'))}
    />
  );
}

function Question({
  q, sessionId, position, total, onDone, onSkip, onDrop, onExit,
}: {
  q: PublicQuestion; sessionId: number; position: number; total: number;
  onDone: (d: Done) => void; onSkip: () => void; onDrop: () => void; onExit: () => void;
}) {
  const names = useTagNames();
  // ---- tracking
  const shownAt = useRef(Date.now());
  const hiddenMs = useRef(0);
  const hiddenSince = useRef<number | null>(null);
  const firstInput = useRef<number | null>(null);
  const changes = useRef(0);
  const events = useRef<{ t: number; kind: string; data?: unknown }[]>([]);
  const log = (kind: string, data?: unknown) => { if (events.current.length < 400) events.current.push({ t: Date.now() - shownAt.current, kind, data }); };
  const touch = (kind = 'change', data?: unknown) => {
    if (firstInput.current === null) firstInput.current = Date.now() - shownAt.current;
    else changes.current++;
    log(kind, data);
  };
  useEffect(() => {
    const vis = () => {
      if (document.hidden) { hiddenSince.current = Date.now(); log('blur'); }
      else if (hiddenSince.current) { hiddenMs.current += Date.now() - hiddenSince.current; hiddenSince.current = null; log('focus'); }
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  // ---- answer state
  const [choice, setChoice] = useState<number | null>(null);
  const [choices, setChoices] = useState<number[]>([]);
  const [tf, setTf] = useState<boolean | null>(null);
  const [blanks, setBlanks] = useState<string[]>(() => Array(q.spec.blanks ?? 0).fill(''));
  const [text, setText] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [selfGraded, setSelfGraded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const firstField = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const order = useMemo(() => {
    const n = q.spec.options?.length ?? 0;
    return q.spec.shuffle === false ? [...Array(n).keys()] : shuffleFor(q.id, n);
  }, [q]);

  useEffect(() => {
    if (result) return;
    const t = setInterval(() => setElapsed(Date.now() - shownAt.current - hiddenMs.current), 1000);
    return () => clearInterval(t);
  }, [result]);

  useEffect(() => {
    if (['fill_blank', 'numeric', 'short_answer'].includes(q.type)) setTimeout(() => firstField.current?.focus(), 0);
  }, [q]);

  const hasAnswer =
    q.type === 'mcq_single' ? choice !== null :
    q.type === 'mcq_multi' ? choices.length > 0 :
    q.type === 'true_false' ? tf !== null :
    q.type === 'fill_blank' ? blanks.some((b) => b.trim()) :
    q.type === 'numeric' ? text.trim() !== '' :
    q.type === 'short_answer' ? text.trim() !== '' : revealed;

  const submit = async (extra: { self_rating?: number } = {}) => {
    if (busy || result) return;
    if (!hasAnswer && q.type !== 'flashcard') return;
    setBusy(true);
    const response =
      q.type === 'mcq_single' ? { choice } :
      q.type === 'mcq_multi' ? { choices } :
      q.type === 'true_false' ? { value: tf } :
      q.type === 'fill_blank' ? { blanks } :
      q.type === 'numeric' ? { value: text } :
      q.type === 'short_answer' ? { text } : {};
    const time_ms = Math.max(0, Date.now() - shownAt.current - hiddenMs.current);
    try {
      const r = await api.post<SubmitResult>('/attempts', {
        session_id: sessionId, question_id: q.id, response, shown_at: shownAt.current, time_ms,
        first_input_ms: firstInput.current, answer_changes: changes.current, hints_used: hints.length,
        confidence, events: events.current, ...extra,
      });
      setResult(r);
      (document.activeElement as HTMLElement | null)?.blur();
      if (q.type === 'flashcard') onDone({ q, result: r, time_ms });
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!result) return;
    onDone({ q, result: selfGraded !== null ? { ...result, score: selfGraded, grade_status: 'self' } : result, time_ms: Date.now() - shownAt.current - hiddenMs.current });
  };

  const selfGrade = async (score: number) => {
    if (!result) return;
    try {
      await api.post(`/grades/${result.attempt_id}`, { score });
      setSelfGraded(score);
    } catch (e: any) { toast(e.message, 'bad'); }
  };

  const hint = async () => {
    if (result || hints.length >= q.hints) return;
    const r = await api.get<{ hint: string }>(`/questions/${q.id}/hint/${hints.length}`);
    setHints((h) => [...h, r.hint]);
    log('hint', hints.length);
  };

  const pick = (displayIdx: number) => {
    if (result || displayIdx >= order.length) return;
    const orig = order[displayIdx];
    if (q.type === 'mcq_single') { setChoice(orig); touch('change', orig); }
    else { setChoices((c) => (c.includes(orig) ? c.filter((x) => x !== orig) : [...c, orig])); touch('change', orig); }
  };

  const setConf = (v: number) => { if (!result && q.type !== 'flashcard') { setConfidence((c) => (c === v ? null : v)); log('confidence', v); } };

  const reveal = () => { if (!revealed) { setRevealed(true); touch('reveal'); } };

  const keys: Record<string, (e: KeyboardEvent) => unknown> = {
    Escape: () => { if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur(); else onExit(); },
    Enter: () => {
      if (result) { if (q.type !== 'flashcard') next(); return; }
      if (q.type === 'short_answer') return false; // newline; Ctrl+Enter submits
      if (q.type === 'flashcard') { reveal(); return; }
      submit();
    },
    'mod+Enter': () => (result ? next() : submit()),
    ' ': () => {
      if (q.type === 'flashcard' && !revealed) reveal();
      else if (result) next();
      else return false;
    },
    h: hint, 'alt+h': hint,
    x: () => setFlagOpen(true),
    s: () => { if (!result) onSkip(); },
    e: () => { window.open(`/library/${q.id}`, '_blank'); },
  };
  for (const c of CONF) { keys[c.key] = () => setConf(c.v); keys[`alt+${c.v}`] = () => setConf(c.v); }
  for (let i = 1; i <= 9; i++) {
    keys[String(i)] = () => {
      if (q.type === 'mcq_single' || q.type === 'mcq_multi') pick(i - 1);
      else if (q.type === 'true_false' && i <= 2 && !result) { setTf(i === 1); touch('change', i === 1); }
      else if (q.type === 'flashcard' && revealed && !result && i <= 4) submit({ self_rating: i });
      else if (q.type === 'short_answer' && result?.grade_status === 'pending' && i <= 4) selfGrade(SELF[i - 1].score);
      else return false;
    };
  }
  if (q.type === 'true_false') {
    keys.t = () => { if (!result) { setTf(true); touch('change', true); } };
    keys.f = () => { if (!result) { setTf(false); touch('change', false); } };
  }
  useKeys(keys, { enabled: !flagOpen, allowInInput: ['Escape', 'Enter'] });

  const correctSet: Set<number> = result
    ? new Set(q.type === 'mcq_single' ? [result.answer.correct] : q.type === 'mcq_multi' ? result.answer.correct : [])
    : new Set();
  const chosenSet = new Set(q.type === 'mcq_single' ? (choice !== null ? [choice] : []) : choices);
  const progress = (position / total) * 100;

  return (
    <div className="min-h-full flex flex-col">
      <div className="h-[2px] bg-line"><div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress}%` }} /></div>
      <header className="flex items-center justify-between px-6 h-12 text-[12.5px] text-muted">
        <button onClick={onExit} className="hover:text-text flex items-center gap-2"><Kbd>Esc</Kbd> End</button>
        <div className="tabular-nums">{position + 1} / {total}</div>
        <div className="tabular-nums w-16 text-right">{elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : fmtMs(Math.floor(elapsed / 1000) * 1000)}</div>
      </header>

      <div className="flex-1 w-full max-w-[720px] mx-auto px-6 pt-[6vh] pb-24 fade-in">
        <div className="flex items-center gap-2 text-[12px] text-faint mb-4 flex-wrap">
          <span>{TYPE_LABELS[q.type]}</span>
          <span>·</span>
          <span>{q.tags.map((t) => tagLabel(t, names)).join(', ')}</span>
          <span className="ml-auto">difficulty {q.difficulty}</span>
        </div>

        <Md src={q.type === 'fill_blank' ? numberBlanks(q.prompt) : q.prompt} className="text-[17px] leading-[1.65]" />

        <div className="mt-7">
          {(q.type === 'mcq_single' || q.type === 'mcq_multi') && (
            <div className="flex flex-col gap-2">
              {q.type === 'mcq_multi' && !result && <div className="text-[12.5px] text-faint mb-1">Select {q.spec.count === 1 ? 'one' : `all that apply (${q.spec.count})`}</div>}
              {order.map((orig, i) => {
                const chosen = chosenSet.has(orig);
                const right = correctSet.has(orig);
                const tone = result ? (right ? 'border-good/60 bg-good-soft' : chosen ? 'border-bad/60 bg-bad-soft' : 'border-line opacity-60') : chosen ? 'border-accent/70 bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-hover';
                return (
                  <button key={orig} onClick={() => pick(i)} disabled={!!result} className={`flex items-start gap-3 text-left rounded-xl border px-4 py-3 transition-colors duration-100 ${tone}`}>
                    <Kbd className="mt-[3px] shrink-0">{i + 1}</Kbd>
                    <Md src={q.spec.options[orig]} className="flex-1" />
                    {result && right && <span className="text-good text-[12px] mt-0.5">correct</span>}
                    {result && chosen && !right && <span className="text-bad text-[12px] mt-0.5">your answer</span>}
                  </button>
                );
              })}
            </div>
          )}

          {q.type === 'true_false' && (
            <div className="grid grid-cols-2 gap-3">
              {[true, false].map((v, i) => {
                const right = result && result.answer.correct === v;
                const chosen = tf === v;
                const tone = result ? (right ? 'border-good/60 bg-good-soft' : chosen ? 'border-bad/60 bg-bad-soft' : 'border-line opacity-60') : chosen ? 'border-accent/70 bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-hover';
                return (
                  <button key={String(v)} disabled={!!result} onClick={() => { setTf(v); touch('change', v); }} className={`h-14 rounded-xl border flex items-center justify-center gap-3 text-[15px] transition-colors ${tone}`}>
                    <Kbd>{i + 1}</Kbd> {v ? 'True' : 'False'} <span className="text-faint text-[12px]">({v ? 't' : 'f'})</span>
                  </button>
                );
              })}
            </div>
          )}

          {q.type === 'fill_blank' && (
            <div className="flex flex-col gap-2.5">
              {blanks.map((b, i) => {
                const ok = result?.detail?.blanks?.[i];
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="w-5 text-right text-faint tabular-nums text-[13px]">{i + 1}</span>
                    <input
                      ref={i === 0 ? firstField : undefined}
                      value={b}
                      disabled={!!result}
                      onChange={(e) => { const v = [...blanks]; v[i] = e.target.value; setBlanks(v); if (firstInput.current === null) touch(); }}
                      onBlur={() => log('change', i)}
                      className={`field max-w-sm ${result ? (ok ? 'border-good/60' : 'border-bad/60') : ''}`}
                    />
                    {result && !ok && <span className="text-[13px] text-muted">→ <span className="text-text">{result.detail.accept[i]}</span></span>}
                  </div>
                );
              })}
            </div>
          )}

          {q.type === 'numeric' && (
            <div className="flex items-center gap-3">
              <input
                ref={firstField}
                value={text}
                disabled={!!result}
                inputMode="decimal"
                placeholder="Your answer"
                onChange={(e) => { setText(e.target.value); if (firstInput.current === null) touch(); }}
                onBlur={() => log('change')}
                className={`field max-w-[240px] font-mono ${result ? (result.correct ? 'border-good/60' : 'border-bad/60') : ''}`}
              />
              {q.spec.unit && <span className="text-muted">{q.spec.unit}</span>}
              {result && !result.correct && <span className="text-[13px] text-muted">→ <span className="text-text font-mono">{result.answer.answer}</span>{result.answer.tolerance ? <span className="text-faint"> (±{result.answer.relative ? `${result.answer.tolerance * 100}%` : result.answer.tolerance})</span> : null}</span>}
            </div>
          )}

          {q.type === 'short_answer' && (
            <div>
              <textarea
                ref={firstField}
                value={text}
                disabled={!!result}
                rows={q.spec.long ? 12 : 5}
                placeholder="Write your answer…  (Ctrl+Enter to submit)"
                onChange={(e) => { setText(e.target.value); if (firstInput.current === null) touch(); }}
                onBlur={() => log('change')}
                className="field text-[14.5px]"
              />
              {!result && q.spec.rubric?.length > 0 && (
                <div className="mt-2 text-[12.5px] text-faint">Graded on: {q.spec.rubric.map((r: any) => `${r.criterion} (${r.points})`).join(' · ')}</div>
              )}
            </div>
          )}

          {q.type === 'flashcard' && (
            revealed ? (
              <div className="border-t border-line pt-6 fade-in"><Md src={q.spec.back} /></div>
            ) : null
          )}
        </div>

        {hints.length > 0 && (
          <div className="mt-6 space-y-2">
            {hints.map((h, i) => (
              <div key={i} className="text-[13.5px] text-muted border-l-2 border-line-strong pl-3"><span className="text-faint mr-2">Hint {i + 1}</span><Md src={h} inline /></div>
            ))}
          </div>
        )}

        {result && q.type !== 'flashcard' && <Feedback q={q} result={result} selfGraded={selfGraded} onSelfGrade={selfGrade} />}
      </div>

      <footer className="sticky bottom-0 border-t border-line bg-bg/95 backdrop-blur">
        <div className="max-w-[720px] mx-auto px-6 h-14 flex items-center gap-3">
          {!result && q.type !== 'flashcard' && (
            <div className="flex items-center gap-1">
              {CONF.map((c) => (
                <button key={c.v} onClick={() => setConf(c.v)} className={`h-7 px-2 rounded-md text-[12px] flex items-center gap-1.5 transition-colors ${confidence === c.v ? 'bg-elev text-text shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-faint hover:text-muted'}`}>
                  <span className="font-mono text-[10.5px] opacity-70">{c.key}</span>{c.label}
                </button>
              ))}
            </div>
          )}
          {q.hints > hints.length && !result && <Button variant="ghost" size="sm" onClick={hint} kbd="h">Hint</Button>}
          <div className="ml-auto flex items-center gap-2">
            {!result && <Button variant="ghost" size="sm" onClick={() => setFlagOpen(true)} kbd="x">Flag</Button>}
            {!result && q.type !== 'flashcard' && <Button variant="ghost" size="sm" onClick={onSkip} kbd="s">Skip</Button>}
            {q.type === 'flashcard' && !revealed && <Button variant="primary" onClick={reveal} kbd="Space">Show answer</Button>}
            {q.type === 'flashcard' && revealed && !result && FLASH.map((f) => (
              <Button key={f.r} variant={f.r === 3 ? 'primary' : 'secondary'} onClick={() => submit({ self_rating: f.r })} kbd={String(f.r)}>{f.label}</Button>
            ))}
            {!result && q.type !== 'flashcard' && (
              <Button variant="primary" onClick={() => submit()} disabled={!hasAnswer || busy} kbd={q.type === 'short_answer' ? 'Ctrl ↵' : '↵'}>Check</Button>
            )}
            {result && q.type !== 'flashcard' && <Button variant="primary" onClick={next} kbd="↵">{position + 1 === total ? 'Finish' : 'Next'}</Button>}
          </div>
        </div>
      </footer>

      <FlagDialog open={flagOpen} onClose={() => setFlagOpen(false)} onFlag={async (reason) => {
        await api.post(`/questions/${q.id}/flag`, { reason });
        setFlagOpen(false);
        toast('Flagged. It is hidden from study until fixed.');
        if (!result) onDrop(); else next();
      }} />
    </div>
  );
}

function Feedback({ q, result, selfGraded, onSelfGrade }: { q: PublicQuestion; result: SubmitResult; selfGraded: number | null; onSelfGrade: (s: number) => void }) {
  const pending = result.grade_status === 'pending';
  const verdict = pending ? null : result.correct ? 'Correct' : (result.score ?? 0) > 0 ? `Partly correct · ${pct(result.score)}` : 'Incorrect';
  return (
    <div className="mt-8 fade-in">
      {verdict && (
        <div className={`text-[13px] font-medium ${result.correct ? 'text-good' : 'text-bad'}`}>
          {verdict}
          {result.next_due && <span className="text-faint font-normal"> · next review in {fmtDue(result.next_due)}</span>}
        </div>
      )}
      {q.type === 'short_answer' && (
        <Card className="mt-3 p-4">
          <div className="text-[12px] text-faint mb-1.5">Model answer</div>
          <Md src={result.answer.model_answer} />
          {result.answer.rubric?.length > 0 && (
            <ul className="mt-3 text-[13px] text-muted space-y-0.5">
              {result.answer.rubric.map((r: any, i: number) => <li key={i}>· {r.criterion} <span className="text-faint">({r.points})</span></li>)}
            </ul>
          )}
          {pending && (
            <div className="mt-4 pt-4 border-t border-line">
              {selfGraded === null ? (
                <>
                  <div className="text-[12.5px] text-muted mb-2">Grade yourself, or press Enter to leave it for your AI agent to grade.</div>
                  <div className="flex gap-1.5">
                    {SELF.map((s, i) => <Button key={s.label} size="sm" onClick={() => onSelfGrade(s.score)} kbd={String(i + 1)}>{s.label}</Button>)}
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-muted">Self-graded: {pct(selfGraded)}</div>
              )}
            </div>
          )}
        </Card>
      )}
      {result.explanation && (
        <div className="mt-4 text-[14px]">
          <div className="text-[12px] text-faint mb-1">Explanation</div>
          <Md src={result.explanation} className="text-muted" />
        </div>
      )}
    </div>
  );
}

function FlagDialog({ open, onClose, onFlag }: { open: boolean; onClose: () => void; onFlag: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Flag question">
      <form onSubmit={(e) => { e.preventDefault(); onFlag(reason.trim() || 'Wrong or unclear'); setReason(''); }}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {['Wrong answer', 'Ambiguous', 'Typo', 'Outdated', 'Too easy'].map((r) => <Chip key={r} active={reason === r} onClick={() => setReason(r)}>{r}</Chip>)}
        </div>
        <input autoFocus className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong? Your AI agent will see this." />
        <div className="flex justify-end gap-2 mt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" kbd="↵">Flag</Button>
        </div>
      </form>
    </Modal>
  );
}

function Summary({ done, onFinish, finished }: { done: Done[]; onFinish: () => void; finished: boolean }) {
  const [, nav] = useLocation();
  useEffect(() => { if (!finished) onFinish(); }, [finished, onFinish]);
  const graded = done.filter((d) => d.result.score !== null);
  const correct = graded.filter((d) => (d.result.score ?? 0) >= 0.8).length;
  const pending = done.filter((d) => d.result.grade_status === 'pending' && d.result.score === null).length;
  const time = done.reduce((s, d) => s + d.time_ms, 0);
  const missed = done.filter((d) => d.result.score !== null && (d.result.score ?? 0) < 0.8);
  useKeys({ Enter: () => nav('/'), Escape: () => nav('/') });
  return (
    <div className="max-w-[640px] mx-auto px-6 pt-[10vh] pb-16 fade-in">
      <div className="text-[12.5px] text-muted">Session complete</div>
      <div className="text-[30px] font-semibold tracking-[-0.02em] mt-1">{graded.length ? pct(correct / graded.length) : '–'}</div>
      <div className="text-muted">{correct} of {graded.length} correct · {done.length} answered · {fmtMs(time)}{pending ? ` · ${pending} awaiting grade` : ''}</div>
      {missed.length > 0 && (
        <div className="mt-8">
          <div className="text-[12.5px] text-muted mb-2">To revisit</div>
          <Card>
            {missed.map((d, i) => (
              <div key={i} className={`px-4 py-3 ${i ? 'border-t border-line' : ''}`}>
                <Md src={d.q.prompt.replace(/\{\{\s*blank\s*\}\}/g, '___')} className="text-[13.5px] line-clamp-2" />
              </div>
            ))}
          </Card>
        </div>
      )}
      <div className="flex gap-2 mt-8">
        <Button variant="primary" onClick={() => nav('/')} kbd="↵">Done</Button>
        <Button onClick={() => nav('/study')}>New session</Button>
      </div>
    </div>
  );
}

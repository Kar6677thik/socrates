import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, invalidate, pct, fmtMs, tagLabel, useTagNames, TYPE_LABELS, type PublicQuestion, type SubmitResult } from '../lib/api';
import { Md, MdLine } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Button, Kbd, Modal, Card, Chip, toast } from '../components/ui';
import { AnswerInput, answerKeys, emptyAnswer, hasAnswer, toResponse, numberBlanks, TEXT_TYPES, MULTILINE, type Answer, type SetAnswer } from '../components/answers';
import { Feedback, clock, type SessionData } from './Study';

/**
 * Exam simulation: answer in any order, change answers, mark questions for review,
 * no feedback until you submit. Then a review screen with every answer and explanation.
 */

const CONF = [
  { v: 1, label: 'Guess', key: 'q' },
  { v: 2, label: 'Unsure', key: 'w' },
  { v: 3, label: 'Likely', key: 'e' },
  { v: 4, label: 'Sure', key: 'r' },
];

interface Track { firstShown: number | null; timeMs: number; firstInput: number | null; changes: number }

export default function Exam({ session }: { session: SessionData }) {
  const qs = session.questions;
  const [answers, setAnswers] = useState<Record<number, Answer>>(() => Object.fromEntries(qs.map((q) => [q.id, emptyAnswer(q)])));
  const [conf, setConf] = useState<Record<number, number | null>>({});
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<'taking' | 'submitting' | 'review'>('taking');
  const [results, setResults] = useState<Record<number, SubmitResult>>({});
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState(0);
  const [, tick] = useState(0);
  const track = useRef<Record<number, Track>>(Object.fromEntries(qs.map((q) => [q.id, { firstShown: null, timeMs: 0, firstInput: null, changes: 0 }])));
  const entered = useRef(Date.now());
  const firstField = useRef<any>(null);
  const deadline = session.time_limit_s ? session.started_at + session.time_limit_s * 1000 : null;
  const startedAt = useRef(Date.now());
  const q = qs[idx];

  /** Bank the time spent on the current question. */
  const bank = useCallback(() => {
    const t = track.current[qs[idx]?.id];
    if (t) t.timeMs += Date.now() - entered.current;
    entered.current = Date.now();
  }, [idx, qs]);

  useEffect(() => {
    const t = track.current[q?.id];
    if (t && t.firstShown === null) t.firstShown = Date.now();
    entered.current = Date.now();
    if (q && TEXT_TYPES.has(q.type)) setTimeout(() => firstField.current?.focus(), 0);
  }, [q]);

  useEffect(() => {
    if (phase !== 'taking') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const go = (i: number) => {
    if (i < 0 || i >= qs.length || i === idx) return;
    bank();
    setIdx(i);
  };

  const set: SetAnswer = (patch, kind) => {
    setAnswers((prev) => ({ ...prev, [q.id]: { ...prev[q.id], ...patch } }));
    if (!kind) return;
    const t = track.current[q.id];
    const onQ = t.timeMs + (Date.now() - entered.current);
    if (t.firstInput === null) t.firstInput = onQ;
    else if (kind === 'change') t.changes++;
  };

  const submitAll = useCallback(async () => {
    if (phase !== 'taking') return;
    bank();
    setConfirm(false);
    setPhase('submitting');
    const out: Record<number, SubmitResult> = {};
    for (let i = 0; i < qs.length; i++) {
      const x = qs[i];
      const a = answers[x.id];
      const t = track.current[x.id];
      const answered = hasAnswer(x, a);
      try {
        out[x.id] = await api.post<SubmitResult>('/attempts', {
          session_id: session.session_id, question_id: x.id, response: toResponse(x, a),
          shown_at: t.firstShown ?? Date.now(), time_ms: Math.round(t.timeMs), first_input_ms: t.firstInput === null ? null : Math.round(t.firstInput),
          answer_changes: t.changes, confidence: conf[x.id] ?? null, unanswered: !answered || undefined,
        });
      } catch (e: any) {
        toast(`Question ${i + 1}: ${e.message}`, 'bad');
      }
      setProgress(i + 1);
    }
    api.post(`/sessions/${session.session_id}/end`).catch(() => {});
    invalidate('/home', '/grades', '/questions', '/analytics', '/recommendations');
    setResults(out);
    setPhase('review');
  }, [phase, bank, qs, answers, conf, session.session_id]);

  // Auto-submit when time runs out.
  useEffect(() => {
    if (!deadline || phase !== 'taking') return;
    const t = setTimeout(() => { toast("Time's up. Submitting your exam."); submitAll(); }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
  }, [deadline, phase, submitAll]);

  const a = answers[q?.id];
  const keys: Record<string, (e: KeyboardEvent) => unknown> =
    phase === 'taking' && !confirm
      ? {
          ArrowRight: () => go(idx + 1), ']': () => go(idx + 1),
          ArrowLeft: () => go(idx - 1), '[': () => go(idx - 1),
          Enter: () => { if (MULTILINE.has(q.type)) return false; go(idx + 1); },
          m: () => setMarked((s) => { const n = new Set(s); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; }),
          'mod+Enter': () => setConfirm(true),
          Escape: () => { if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur(); else setConfirm(true); },
          ...Object.fromEntries(CONF.flatMap((c) => [[c.key, () => setConf((p) => ({ ...p, [q.id]: p[q.id] === c.v ? null : c.v }))], [`alt+${c.v}`, () => setConf((p) => ({ ...p, [q.id]: c.v }))]])),
          ...answerKeys(q, a, set, false),
        }
      : {};
  useKeys(keys, { allowInInput: ['Escape'] });

  if (phase === 'review') return <Review qs={qs} answers={answers} results={results} marked={marked} track={track.current} timeUsed={Date.now() - startedAt.current} />;
  if (phase === 'submitting')
    return (
      <div className="min-h-full grid place-items-center">
        <div className="text-center">
          <div className="text-muted">Grading your exam…</div>
          <div className="mt-3 w-56 h-1 rounded-full bg-elev overflow-hidden"><div className="h-full bg-accent transition-[width]" style={{ width: `${(progress / qs.length) * 100}%` }} /></div>
          <div className="text-faint text-[12px] mt-2 tabular-nums">{progress} / {qs.length}</div>
        </div>
      </div>
    );

  const answeredCount = qs.filter((x) => hasAnswer(x, answers[x.id])).length;
  const remaining = deadline ? deadline - Date.now() : null;

  return (
    <div className="min-h-full flex flex-col">
      <header className="flex items-center justify-between px-6 h-12 text-[12.5px] text-muted border-b border-line">
        <span className="font-medium text-text">Exam</span>
        <span className="tabular-nums">{answeredCount} of {qs.length} answered{marked.size ? ` · ${marked.size} marked` : ''}</span>
        <span className={`tabular-nums ${remaining !== null && remaining < 60_000 ? 'text-bad' : ''}`}>{remaining !== null ? clock(remaining) : fmtMs(Math.floor((Date.now() - startedAt.current) / 1000) * 1000)}</span>
      </header>

      <div className="flex-1 w-full max-w-[1040px] mx-auto px-6 max-sm:px-4 pt-8 pb-24 grid grid-cols-[1fr_200px] gap-10 max-md:grid-cols-1">
        <ExamQuestion key={q.id} q={q} a={a} set={set} n={idx + 1} firstField={firstField} marked={marked.has(q.id)} />
        <aside className="max-md:order-first">
          <div className="text-[12px] text-faint mb-2">Questions</div>
          <div className="grid grid-cols-5 gap-1.5 max-md:grid-cols-10 max-sm:grid-cols-8">
            {qs.map((x, i) => {
              const done = hasAnswer(x, answers[x.id]);
              return (
                <button
                  key={x.id}
                  onClick={() => go(i)}
                  aria-label={`Question ${i + 1}${done ? ', answered' : ''}${marked.has(x.id) ? ', marked' : ''}`}
                  className={`relative h-8 rounded-md text-[12px] tabular-nums border transition-colors ${i === idx ? 'border-accent text-text' : done ? 'border-line-strong bg-elev text-text' : 'border-line text-faint hover:text-text'}`}
                >
                  {i + 1}
                  {marked.has(x.id) && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-warn" />}
                </button>
              );
            })}
          </div>
          <div className="mt-3 space-y-1 text-[11.5px] text-faint max-md:hidden">
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm border border-line-strong bg-elev" /> answered</div>
            <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 mx-[3px] rounded-full bg-warn" /> marked for review</div>
          </div>
        </aside>
      </div>

      <footer className="sticky bottom-0 border-t border-line bg-bg/95 backdrop-blur">
        <div className="max-w-[1040px] mx-auto px-6 max-sm:px-4 min-h-14 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1 max-sm:w-full max-sm:justify-between">
            {CONF.map((c) => (
              <button key={c.v} onClick={() => setConf((p) => ({ ...p, [q.id]: p[q.id] === c.v ? null : c.v }))} className={`h-7 px-2 rounded-md text-[12px] flex items-center gap-1.5 transition-colors ${conf[q.id] === c.v ? 'bg-elev text-text shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-faint hover:text-muted'}`}>
                <span className="font-mono text-[10.5px] opacity-70">{c.key}</span>{c.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMarked((s) => { const n = new Set(s); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })} kbd="m">{marked.has(q.id) ? 'Unmark' : 'Mark'}</Button>
            <Button size="sm" onClick={() => go(idx - 1)} disabled={idx === 0} kbd="←">Prev</Button>
            <Button size="sm" onClick={() => go(idx + 1)} disabled={idx === qs.length - 1} kbd="→">Next</Button>
            <Button variant="primary" onClick={() => setConfirm(true)} kbd="Ctrl ↵">Submit exam</Button>
          </div>
        </div>
      </footer>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Submit exam?">
        <div className="text-[13.5px] space-y-1.5">
          <div>{answeredCount} of {qs.length} answered.</div>
          {qs.length - answeredCount > 0 && <div className="text-bad">{qs.length - answeredCount} unanswered: they count as wrong.</div>}
          {marked.size > 0 && <div className="text-muted">{marked.size} still marked for review.</div>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={() => setConfirm(false)}>Keep going</Button>
          <Button variant="primary" onClick={submitAll} autoFocus>Submit</Button>
        </div>
      </Modal>
    </div>
  );
}

function ExamQuestion({ q, a, set, n, firstField, marked }: { q: PublicQuestion; a: Answer; set: SetAnswer; n: number; firstField: any; marked: boolean }) {
  const names = useTagNames();
  return (
    <div className="min-w-0 fade-in">
      <div className="flex items-center gap-2 text-[12px] text-faint mb-4 flex-wrap">
        <span className="text-muted font-medium">Question {n}</span>
        <span>·</span>
        <span>{TYPE_LABELS[q.type]}</span>
        <span>·</span>
        <span className="truncate">{q.tags.map((t) => tagLabel(t, names)).join(', ')}</span>
        {marked && <span className="ml-auto text-warn">marked</span>}
      </div>
      <Md src={q.type === 'fill_blank' || q.type === 'cloze' ? numberBlanks(q.prompt) : q.prompt} className="text-[17px] leading-[1.65]" />
      <div className="mt-7"><AnswerInput q={q} a={a} set={set} firstField={firstField} /></div>
    </div>
  );
}

type Filter = 'all' | 'wrong' | 'marked' | 'pending';

function Review({ qs, answers, results, marked, track, timeUsed }: {
  qs: PublicQuestion[]; answers: Record<number, Answer>; results: Record<number, SubmitResult>; marked: Set<number>;
  track: Record<number, Track>; timeUsed: number;
}) {
  const [, nav] = useLocation();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [self, setSelf] = useState<Record<number, number>>({});
  const score = (id: number) => self[id] ?? results[id]?.score ?? null;
  const graded = qs.filter((x) => score(x.id) !== null);
  const total = graded.reduce((s, x) => s + (score(x.id) ?? 0), 0);
  const pending = qs.filter((x) => results[x.id]?.grade_status === 'pending' && self[x.id] === undefined);
  const wrong = (id: number) => (score(id) ?? 1) < 0.8;
  const shown = qs.map((x, i) => ({ x, i })).filter(({ x }) =>
    filter === 'all' ? true : filter === 'wrong' ? wrong(x.id) : filter === 'marked' ? marked.has(x.id) : results[x.id]?.grade_status === 'pending' && self[x.id] === undefined,
  );
  useKeys({ Escape: () => nav('/') });

  const selfGrade = async (id: number, s: number) => {
    try { await api.post(`/grades/${results[id].attempt_id}`, { score: s }); setSelf((p) => ({ ...p, [id]: s })); }
    catch (e: any) { toast(e.message, 'bad'); }
  };

  return (
    <div className="max-w-[820px] mx-auto px-6 max-sm:px-4 pt-[8vh] pb-16 fade-in">
      <div className="text-[12.5px] text-muted">Exam results</div>
      <div className="text-[30px] font-semibold tracking-[-0.02em] mt-1">{graded.length ? pct(total / graded.length) : '–'}</div>
      <div className="text-muted">
        {graded.filter((x) => !wrong(x.id)).length} of {graded.length} correct · {fmtMs(timeUsed)}
        {pending.length ? ` · ${pending.length} awaiting grade` : ''}
      </div>

      <div className="flex gap-1.5 mt-8 mb-3 flex-wrap">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All {qs.length}</Chip>
        <Chip active={filter === 'wrong'} onClick={() => setFilter('wrong')}>Incorrect {qs.filter((x) => wrong(x.id)).length}</Chip>
        {marked.size > 0 && <Chip active={filter === 'marked'} onClick={() => setFilter('marked')}>Marked {marked.size}</Chip>}
        {pending.length > 0 && <Chip active={filter === 'pending'} onClick={() => setFilter('pending')}>To grade {pending.length}</Chip>}
      </div>

      <Card className="overflow-hidden">
        {shown.map(({ x, i }, k) => {
          const r = results[x.id];
          const s = score(x.id);
          const isOpen = open.has(x.id);
          return (
            <div key={x.id} className={k ? 'border-t border-line' : ''}>
              <button
                onClick={() => setOpen((o) => { const n = new Set(o); n.has(x.id) ? n.delete(x.id) : n.add(x.id); return n; })}
                className="w-full flex items-center gap-3 px-4 h-12 text-left hover:bg-hover"
                aria-expanded={isOpen}
              >
                <span className="w-6 text-faint tabular-nums text-[12.5px]">{i + 1}</span>
                <MdLine src={x.prompt} className="flex-1 min-w-0 text-[13.5px]" />
                {marked.has(x.id) && <span className="w-1.5 h-1.5 rounded-full bg-warn" title="Marked" />}
                <span className="text-[12px] text-faint w-12 text-right tabular-nums">{fmtMs(Math.round(track[x.id]?.timeMs ?? 0))}</span>
                <span className={`w-16 text-right text-[12.5px] tabular-nums ${!r ? 'text-faint' : s === null ? 'text-faint' : s >= 0.8 ? 'text-good' : s > 0 ? 'text-warn' : 'text-bad'}`}>
                  {!r ? 'error' : s === null ? 'to grade' : !hasAnswer(x, answers[x.id]) ? 'blank' : pct(s)}
                </span>
              </button>
              {isOpen && r && (
                <div className="px-4 pb-5 pt-1 border-t border-line">
                  <Md src={x.type === 'fill_blank' || x.type === 'cloze' ? numberBlanks(x.prompt) : x.prompt} className="text-[15px] mt-3" />
                  <div className="mt-5"><AnswerInput q={x} a={answers[x.id]} set={() => {}} result={r} locked /></div>
                  <Feedback q={x} result={r} selfGraded={self[x.id] ?? null} onSelfGrade={(v) => selfGrade(x.id, v)} showDue={false} />
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && <div className="px-4 py-8 text-center text-muted text-[13px]">Nothing here.</div>}
      </Card>

      <div className="flex gap-2 mt-8">
        <Button variant="primary" onClick={() => nav('/')}>Done</Button>
        <Button onClick={() => nav('/analytics')}>Analytics</Button>
        <Button variant="ghost" onClick={() => nav('/study')}>New session</Button>
      </div>
      <p className="text-faint text-[12px] mt-4">Every answer updated your review schedule and mastery. Press <Kbd>Esc</Kbd> to go home.</p>
    </div>
  );
}

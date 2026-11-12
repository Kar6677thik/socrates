import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, Link } from 'wouter';
import { api, useApi, invalidate, pct, fmtMs, fmtDue, tagLabel, useTagNames, TYPES, TYPE_LABELS, MODE_LABELS, type PublicQuestion, type SubmitResult, type QType, type Home, type Mode } from '../lib/api';
import { Md, MdLine } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Button, Chip, Kbd, Segmented, Field, Modal, toast, Card } from '../components/ui';
import { TagInput } from '../components/TagInput';
import { startSession } from './Home';
import Exam from './Exam';
import { AnswerInput, answerKeys, emptyAnswer, hasAnswer, toResponse, numberBlanks, TEXT_TYPES, MULTILINE, type Answer, type SetAnswer } from '../components/answers';

export default function StudyPage({ sessionId }: { sessionId?: number }) {
  return sessionId ? <Runner key={sessionId} sessionId={sessionId} /> : <Builder />;
}

// ---------------------------------------------------------------- Builder

const MODE_HELP: Record<Mode, string> = {
  srs: 'Questions due today, lowest recall first, plus new questions within your daily limit.',
  adaptive: 'A mix of due, weak and new questions, picked so you get about 80% right: hard enough to learn from.',
  weak: 'Concentrates on your lowest-mastery tags. Leave tags empty to let the engine pick them.',
  practice: 'A sample weighted toward questions you miss and ones you have not seen.',
  exam: 'A random sample spread across your tags. No feedback until you submit; review everything at the end.',
};

interface Preset { name: string; config: Record<string, any> }

function Builder() {
  const [, nav] = useLocation();
  const { data: h } = useApi<Home>('/home');
  const { data: presets = [], refetch } = useApi<Preset[]>('/presets');
  const [mode, setMode] = useState<Mode>('srs');
  const [tags, setTags] = useState<string[]>([]);
  const [types, setTypes] = useState<QType[]>([]);
  const [diff, setDiff] = useState<number[]>([]);
  const [limit, setLimit] = useState(20);
  const [minutes, setMinutes] = useState(0);
  const [naming, setNaming] = useState<string | null>(null);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const config = () => ({
    mode,
    tags: tags.length ? tags : undefined,
    types: types.length ? types : undefined,
    difficulty: diff.length ? [Math.min(...diff), Math.max(...diff)] : undefined,
    limit: mode === 'srs' ? undefined : limit,
    time_limit_s: minutes ? minutes * 60 : undefined,
  });
  const go = () => startSession(nav, config());
  const load = (p: Preset) => {
    const c = p.config;
    setMode(c.mode ?? 'adaptive');
    setTags(c.tags ?? []);
    setTypes(c.types ?? []);
    setDiff(c.difficulty ? Array.from({ length: c.difficulty[1] - c.difficulty[0] + 1 }, (_, i) => c.difficulty[0] + i) : []);
    setLimit(c.limit ?? 20);
    setMinutes(c.time_limit_s ? Math.round(c.time_limit_s / 60) : 0);
  };
  const savePresets = async (list: Preset[]) => {
    try { await api.put('/presets', list); refetch(); } catch (e: any) { toast(e.message, 'bad'); }
  };
  useKeys({ 'mod+Enter': go, Enter: () => { if (naming === null) go(); } });

  return (
    <div className="max-w-2xl fade-in">
      <h1 className="text-[19px] font-semibold tracking-[-0.01em] mb-6">New session</h1>
      {presets.length > 0 && (
        <div className="mb-6">
          <div className="text-[12.5px] font-medium text-muted mb-1.5">Presets</div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p, i) => (
              <span key={i} className="group inline-flex items-center h-7 rounded-md border border-line hover:border-line-strong text-[12.5px]">
                <button className="pl-2.5 pr-1.5 h-full" onClick={() => load(p)} onDoubleClick={() => startSession(nav, p.config)} title="Click to load, double-click to start">{p.name}</button>
                <button className="pr-2 text-faint hover:text-text opacity-0 group-hover:opacity-100" onClick={() => savePresets(presets.filter((_, j) => j !== i))} aria-label={`Delete preset ${p.name}`}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-6">
        <Segmented
          value={mode}
          onChange={setMode}
          options={(['srs', 'adaptive', 'weak', 'practice', 'exam'] as Mode[]).map((m) => ({
            value: m,
            label: m === 'srs' && h ? `${MODE_LABELS[m]} · ${h.due + h.new_available}` : MODE_LABELS[m],
          }))}
        />
        <p className="text-muted -mt-3 text-[13px]">{MODE_HELP[mode]} Every answer updates your schedule and mastery.</p>
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
        {mode !== 'srs' && (
          <Field label="Questions">
            <div className="flex gap-1.5">
              {[10, 20, 40, 80].map((n) => <Chip key={n} active={limit === n} onClick={() => setLimit(n)}>{n}</Chip>)}
            </div>
          </Field>
        )}
        <Field label="Time limit" hint={minutes ? (mode === 'exam' ? 'The exam submits itself when time runs out.' : 'The session ends when time runs out.') : undefined}>
          <div className="flex gap-1.5 flex-wrap">
            {[0, 5, 10, 20, 30, 60, 90].map((m) => <Chip key={m} active={minutes === m} onClick={() => setMinutes(m)}>{m ? `${m} min` : 'None'}</Chip>)}
          </div>
        </Field>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="lg" kbd="↵" onClick={go}>Start</Button>
          {naming === null ? (
            <Button variant="ghost" size="lg" onClick={() => setNaming('')}>Save as preset</Button>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); if (naming.trim()) { savePresets([...presets, { name: naming, config: config() }]); toast('Preset saved'); } setNaming(null); }}
            >
              <input autoFocus className="field h-10 w-48" placeholder="Preset name" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
              <Button type="submit" size="lg">Save</Button>
            </form>
          )}
        </div>
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

export interface SessionData {
  session_id: number;
  mode: Mode;
  questions: PublicQuestion[];
  answered: number;
  started_at: number;
  time_limit_s: number | null;
}

/** "4:05" style countdown text. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

function Runner({ sessionId }: { sessionId: number }) {
  const { data, error } = useApi<SessionData>(`/sessions/${sessionId}`);
  if (error) return <div className="p-10 text-muted">{(error as Error).message}</div>;
  if (!data) return null;
  if (data.mode === 'exam' && !data.questions.length)
    return (
      <div className="max-w-md mx-auto pt-[20vh] px-6 text-center fade-in">
        <div className="font-medium">This exam has been submitted</div>
        <div className="text-muted mt-1">Its answers are in your analytics and review schedule.</div>
        <div className="flex gap-2 justify-center mt-6"><Link href="/analytics"><Button>Analytics</Button></Link><Link href="/study"><Button variant="primary">New session</Button></Link></div>
      </div>
    );
  if (data.mode === 'exam') return <Exam session={data} />;
  return <Practice session={data} />;
}

function Practice({ session }: { session: SessionData }) {
  const [, nav] = useLocation();
  const sessionId = session.session_id;
  const [queue, setQueue] = useState<PublicQuestion[]>(session.questions);
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [finished, setFinished] = useState(false);
  const [mount, setMount] = useState(0);
  const deadline = session.time_limit_s ? session.started_at + session.time_limit_s * 1000 : null;

  const finish = useCallback(async () => {
    setFinished(true);
    api.post(`/sessions/${sessionId}/end`).catch(() => {});
    invalidate('/home', '/grades', '/questions', '/analytics', '/recommendations');
  }, [sessionId]);

  useEffect(() => {
    if (!deadline || finished) return;
    const t = setTimeout(() => { toast("Time's up"); finish(); }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
  }, [deadline, finished, finish]);

  /** Undo an answer: the server restores schedule + calibration, and the question is shown again fresh. */
  const undo = async (attemptId: number, stepBack: boolean) => {
    try {
      await api.post(`/attempts/${attemptId}/undo`);
      if (stepBack) { setDone((d) => d.slice(0, -1)); setIdx((i) => i - 1); }
      setMount((m) => m + 1);
      toast('Answer undone');
    } catch (e: any) { toast(e.message, 'bad'); }
  };

  if (finished || idx >= queue.length) return <Summary done={done} onFinish={finish} finished={finished} />;

  const q = queue[idx];
  return (
    <Question
      key={`${q.id}-${idx}-${mount}`}
      q={q}
      sessionId={sessionId}
      position={idx}
      total={queue.length}
      deadline={deadline}
      onUndo={(attemptId) => undo(attemptId, false)}
      onUndoPrevious={done.length ? () => undo(done[done.length - 1].result.attempt_id, true) : undefined}
      onDone={(d) => { setDone((x) => [...x, d]); setIdx((i) => i + 1); }}
      onSkip={() => { setQueue((qs) => [...qs, qs[idx]]); setIdx((i) => i + 1); }}
      onDrop={() => { setQueue((qs) => qs.filter((_, i) => i !== idx)); }}
      onExit={() => (done.length ? finish() : nav('/'))}
    />
  );
}

/** Tracks time on a question (excluding hidden-tab time), first input, answer changes and events. */
export function useTracking() {
  const shownAt = useRef(Date.now());
  const hiddenMs = useRef(0);
  const hiddenSince = useRef<number | null>(null);
  const firstInput = useRef<number | null>(null);
  const changes = useRef(0);
  const events = useRef<{ t: number; kind: string; data?: unknown }[]>([]);
  const log = (kind: string, data?: unknown) => { if (events.current.length < 400) events.current.push({ t: Date.now() - shownAt.current, kind, data }); };
  /** 'type' marks the first input only; 'change' (a discrete choice) also counts as an answer change. */
  const touch = (kind: string, data?: unknown) => {
    if (firstInput.current === null) firstInput.current = Date.now() - shownAt.current;
    else if (kind === 'change') changes.current++;
    if (kind !== 'type') log(kind, data);
  };
  useEffect(() => {
    const vis = () => {
      if (document.hidden) { hiddenSince.current = Date.now(); log('blur'); }
      else if (hiddenSince.current) { hiddenMs.current += Date.now() - hiddenSince.current; hiddenSince.current = null; log('focus'); }
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const activeMs = () => Math.max(0, Date.now() - shownAt.current - hiddenMs.current);
  return { shownAt, firstInput, changes, events, log, touch, activeMs };
}

function Question({
  q, sessionId, position, total, deadline, onDone, onSkip, onDrop, onExit, onUndo, onUndoPrevious,
}: {
  q: PublicQuestion; sessionId: number; position: number; total: number; deadline: number | null;
  onDone: (d: Done) => void; onSkip: () => void; onDrop: () => void; onExit: () => void;
  onUndo: (attemptId: number) => void; onUndoPrevious?: () => void;
}) {
  const names = useTagNames();
  const tr = useTracking();
  const [a, setA] = useState<Answer>(() => emptyAnswer(q));
  const [confidence, setConfidence] = useState<number | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [selfGraded, setSelfGraded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [, tick] = useState(0);
  const firstField = useRef<any>(null);

  const set: SetAnswer = (patch, kind, data) => {
    setA((prev) => ({ ...prev, ...patch }));
    if (kind) tr.touch(kind, data);
  };

  useEffect(() => {
    if (result && !deadline) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [result, deadline]);

  useEffect(() => {
    if (TEXT_TYPES.has(q.type)) setTimeout(() => firstField.current?.focus(), 0);
  }, [q]);

  const ready = hasAnswer(q, a);
  const selfGradable = (q.type === 'short_answer' || (q.type === 'code' && !q.spec.auto)) && result?.grade_status === 'pending';

  const submit = async (extra: { self_rating?: number } = {}) => {
    if (busy || result) return;
    if (!ready && q.type !== 'flashcard') return;
    setBusy(true);
    const time_ms = tr.activeMs();
    try {
      const r = await api.post<SubmitResult>('/attempts', {
        session_id: sessionId, question_id: q.id, response: toResponse(q, a), shown_at: tr.shownAt.current, time_ms,
        first_input_ms: tr.firstInput.current, answer_changes: tr.changes.current, hints_used: hints.length,
        confidence, events: tr.events.current, ...extra,
      });
      setResult(r);
      if (r.leech) toast('You keep missing this one, so it is set aside. Rewrite or split it from the library.', 'neutral', { label: 'Edit', run: () => window.open(`/library/${q.id}`, '_blank') });
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
    onDone({ q, result: selfGraded !== null ? { ...result, score: selfGraded, grade_status: 'self' } : result, time_ms: tr.activeMs() });
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
    tr.log('hint', hints.length);
  };

  const setConf = (v: number) => { if (!result && q.type !== 'flashcard') { setConfidence((c) => (c === v ? null : v)); tr.log('confidence', v); } };
  const reveal = () => { if (!revealed) { setRevealed(true); tr.touch('reveal'); } };

  const keys: Record<string, (e: KeyboardEvent) => unknown> = {
    Escape: () => { if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur(); else onExit(); },
    Enter: () => {
      if (result) { if (q.type !== 'flashcard') next(); return; }
      if (MULTILINE.has(q.type)) return false; // newline; Ctrl+Enter submits
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
    o: () => { window.open(`/library/${q.id}`, '_blank'); },
    z: () => {
      if (result) onUndo(result.attempt_id);
      else if (tr.firstInput.current === null && onUndoPrevious) onUndoPrevious();
      else return false;
    },
  };
  for (const c of CONF) { keys[c.key] = () => setConf(c.v); keys[`alt+${c.v}`] = () => setConf(c.v); }
  for (let i = 1; i <= 4; i++)
    keys[String(i)] = () => {
      if (q.type === 'flashcard' && revealed && !result) submit({ self_rating: i });
      else if (selfGradable && selfGraded === null) selfGrade(SELF[i - 1].score);
      else return false;
    };
  Object.assign(keys, answerKeys(q, a, set, !!result));
  useKeys(keys, { enabled: !flagOpen, allowInInput: ['Escape', 'Enter'] });

  const progress = (position / total) * 100;
  const elapsed = tr.activeMs();
  const remaining = deadline ? deadline - Date.now() : null;

  return (
    <div className="min-h-full flex flex-col">
      <div className="h-[2px] bg-line"><div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress}%` }} /></div>
      <header className="flex items-center justify-between px-6 h-12 text-[12.5px] text-muted">
        <button onClick={onExit} className="hover:text-text flex items-center gap-2"><Kbd>Esc</Kbd> End</button>
        <div className="tabular-nums">{position + 1} / {total}</div>
        <div className={`tabular-nums w-16 text-right ${remaining !== null && remaining < 60_000 ? 'text-bad' : ''}`} title={remaining !== null ? 'Time left in session' : 'Time on this question'}>
          {remaining !== null ? clock(remaining) : elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : fmtMs(Math.floor(elapsed / 1000) * 1000)}
        </div>
      </header>

      <div className="flex-1 w-full max-w-[720px] mx-auto px-6 max-sm:px-4 pt-[6vh] pb-24 fade-in">
        <div className="flex items-center gap-2 text-[12px] text-faint mb-4 flex-wrap">
          <span>{TYPE_LABELS[q.type]}</span>
          <span>·</span>
          <span>{q.tags.map((t) => tagLabel(t, names)).join(', ')}</span>
          <span className="ml-auto">difficulty {q.difficulty}</span>
        </div>

        <Md src={q.type === 'fill_blank' || q.type === 'cloze' ? numberBlanks(q.prompt) : q.prompt} className="text-[17px] leading-[1.65]" />

        <div className="mt-7">
          <AnswerInput q={q} a={a} set={set} result={result} firstField={firstField} revealed={revealed} />
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
        <div className="max-w-[720px] mx-auto px-6 max-sm:px-4 min-h-14 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          {!result && q.type !== 'flashcard' && (
            <div className="flex items-center gap-1 max-sm:w-full max-sm:justify-between">
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
              <Button variant="primary" onClick={() => submit()} disabled={!ready || busy} kbd={MULTILINE.has(q.type) ? 'Ctrl ↵' : '↵'}>{busy && q.type === 'code' ? 'Running…' : 'Check'}</Button>
            )}
            {result && q.type !== 'flashcard' && <Button variant="ghost" size="sm" onClick={() => onUndo(result.attempt_id)} kbd="z">Undo</Button>}
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

/** Verdict, model answer / reference solution with self-grading, and explanation. */
export function Feedback({ q, result, selfGraded, onSelfGrade, showDue = true }: { q: PublicQuestion; result: SubmitResult; selfGraded: number | null; onSelfGrade?: (s: number) => void; showDue?: boolean }) {
  const pending = result.grade_status === 'pending';
  const score = selfGraded ?? result.score;
  const verdict = pending && selfGraded === null ? null : (score ?? 0) >= 1 || result.correct ? 'Correct' : (score ?? 0) > 0 ? `Partly correct · ${pct(score)}` : 'Incorrect';
  const reference = q.type === 'short_answer' ? result.answer.model_answer : q.type === 'code' && !q.spec.auto ? result.answer.reference_solution : null;
  return (
    <div className="mt-8 fade-in">
      {verdict && (
        <div className={`text-[13px] font-medium ${verdict === 'Correct' ? 'text-good' : 'text-bad'}`}>
          {verdict}
          {showDue && result.next_due && <span className="text-faint font-normal"> · next review in {fmtDue(result.next_due)}</span>}
        </div>
      )}
      {reference && (
        <Card className="mt-3 p-4">
          <div className="text-[12px] text-faint mb-1.5">{q.type === 'code' ? 'Reference solution' : 'Model answer'}</div>
          <Md src={q.type === 'code' ? '```' + q.spec.language + '\n' + reference + '\n```' : reference} />
          {result.answer.rubric?.length > 0 && (
            <ul className="mt-3 text-[13px] text-muted space-y-0.5">
              {result.answer.rubric.map((r: any, i: number) => <li key={i}>· {r.criterion} <span className="text-faint">({r.points})</span></li>)}
            </ul>
          )}
          {pending && onSelfGrade && (
            <div className="mt-4 pt-4 border-t border-line">
              {selfGraded === null ? (
                <>
                  <div className="text-[12.5px] text-muted mb-2">Grade yourself, or move on and leave it for your AI agent to grade.</div>
                  <div className="flex gap-1.5 flex-wrap">
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
                <MdLine src={d.q.prompt} className="text-[13.5px]" />
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

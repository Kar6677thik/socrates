import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, useApi, invalidate, TYPES, TYPE_LABELS, ago, pct, fmtMs, fmtDue, tagLabel, useTagNames, type Question, type QType, type SourceRef } from '../lib/api';
import { Md, firstAlt } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Button, Field, Badge, Card, Segmented, toast, Kbd, SourceLine } from '../components/ui';
import { TagInput } from '../components/TagInput';
import { PromptField, ClozeHelp, MatchingForm, OrderingForm, CodeForm, HotspotForm } from '../components/EditorExtras';

/** Cloze answers (first alternative of each {{cN::…}}), for previews. */
const clozeAnswers = (prompt: string) => [...prompt.matchAll(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g)].map((m) => firstAlt(m[1]));

export interface Draft {
  type: QType;
  prompt: string;
  tags: string[];
  difficulty: number;
  explanation: string;
  hints: string[];
  citation: string;
  /** Link to the note/card it was made from; kept as is unless removed. */
  source: SourceRef | null;
  spec: any;
}

const DEFAULT_SPEC: Record<QType, any> = {
  mcq_single: { options: ['', '', '', ''], correct: 0 },
  mcq_multi: { options: ['', '', '', ''], correct: [0] },
  true_false: { correct: true },
  fill_blank: { blanks: [{ accept: [''] }] },
  numeric: { answer: 0 },
  short_answer: { model_answer: '', rubric: [] },
  flashcard: { back: '' },
  matching: { pairs: [{ left: '', right: '' }, { left: '', right: '' }, { left: '', right: '' }] },
  ordering: { items: ['', '', ''] },
  cloze: {},
  code: { language: 'javascript', function_name: 'solution', starter: 'function solution() {\n  \n}\n', tests: [{ args: [], expected: null }] },
  hotspot: { image: '', regions: [] },
};

export const toDraft = (q: Question): Draft => ({
  type: q.type, prompt: q.prompt, tags: q.tags.map((t) => t.path), difficulty: q.difficulty,
  explanation: q.explanation ?? '', hints: q.hints, citation: q.citation ?? '', source: q.source, spec: q.spec,
});

/** Flat payload the API expects (common fields + type-specific fields). */
export function toPayload(d: Draft) {
  const spec = { ...d.spec };
  if (d.type === 'mcq_single' || d.type === 'mcq_multi') spec.options = spec.options.map((o: string) => o.trim());
  if (d.type === 'fill_blank') spec.blanks = spec.blanks.map((b: any) => ({ ...b, accept: b.accept.map((a: string) => a.trim()).filter(Boolean) }));
  if (d.type === 'short_answer' && !spec.rubric?.length) delete spec.rubric;
  if (d.type === 'matching') {
    spec.pairs = spec.pairs.map((p: any) => ({ left: p.left.trim(), right: p.right.trim() }));
    spec.distractors = (spec.distractors ?? []).map((x: string) => x.trim()).filter(Boolean);
    if (!spec.distractors.length) delete spec.distractors;
  }
  if (d.type === 'ordering') spec.items = spec.items.map((x: string) => x.trim());
  if (d.type === 'code') {
    if (!/^(js|javascript)$/i.test(spec.language)) { delete spec.tests; delete spec.function_name; }
    else if (!spec.tests?.length) delete spec.tests;
    for (const k of ['starter', 'reference_solution', 'function_name']) if (!spec[k]) delete spec[k];
  }
  if (d.type === 'numeric') {
    spec.answer = Number(spec.answer);
    if (spec.tolerance === '' || spec.tolerance == null) delete spec.tolerance; else spec.tolerance = Number(spec.tolerance);
    if (!spec.unit) delete spec.unit;
  }
  return {
    type: d.type, prompt: d.prompt, tags: d.tags, difficulty: d.difficulty,
    explanation: d.explanation.trim() || null, hints: d.hints.filter((h) => h.trim()), citation: d.citation.trim() || null, source: d.source, ...spec,
  };
}

export function QuestionForm({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const spec = (patch: any) => onChange({ ...draft, spec: { ...draft.spec, ...patch } });
  const s = draft.spec;
  const blankCount = (draft.prompt.match(/\{\{\s*blank\s*\}\}/g) ?? []).length;

  return (
    <div className="space-y-5">
      <Field label="Type">
        <select
          className="field h-9"
          value={draft.type}
          onChange={(e) => {
            const t = e.target.value as QType;
            const carry = (t.startsWith('mcq') && draft.type.startsWith('mcq')) ? { options: s.options, correct: t === 'mcq_multi' ? [].concat(s.correct) : Array.isArray(s.correct) ? s.correct[0] ?? 0 : s.correct } : DEFAULT_SPEC[t];
            onChange({ ...draft, type: t, spec: carry });
          }}
        >
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
      </Field>

      <Field label="Question" hint={draft.type === 'fill_blank' ? 'Mark each blank with {{blank}}. Markdown, $LaTeX$ and ```code``` work. Paste or drop images.' : 'Markdown, $LaTeX$, $$display math$$ and ```code``` blocks work. Paste or drop images.'}>
        <PromptField value={draft.prompt} onChange={(prompt) => set({ prompt })} />
      </Field>
      {draft.type === 'cloze' && <ClozeHelp />}
      {draft.type === 'matching' && <MatchingForm s={s} spec={spec} />}
      {draft.type === 'ordering' && <OrderingForm s={s} spec={spec} />}
      {draft.type === 'code' && <CodeForm s={s} spec={spec} />}
      {draft.type === 'hotspot' && <HotspotForm s={s} spec={spec} />}

      {(draft.type === 'mcq_single' || draft.type === 'mcq_multi') && (
        <Field label={draft.type === 'mcq_single' ? 'Options (select the correct one)' : 'Options (select all correct)'}>
          <div className="space-y-2">
            {s.options.map((o: string, i: number) => {
              const isCorrect = draft.type === 'mcq_single' ? s.correct === i : s.correct.includes(i);
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type={draft.type === 'mcq_single' ? 'radio' : 'checkbox'}
                    checked={isCorrect}
                    onChange={() => spec({ correct: draft.type === 'mcq_single' ? i : isCorrect ? s.correct.filter((x: number) => x !== i) : [...s.correct, i].sort() })}
                    className="accent-[var(--good)] w-4 h-4"
                    aria-label={`Option ${i + 1} correct`}
                  />
                  <input className="field" value={o} placeholder={`Option ${i + 1}`} onChange={(e) => { const v = [...s.options]; v[i] = e.target.value; spec({ options: v }); }} />
                  <button
                    type="button"
                    disabled={s.options.length <= 2}
                    className="text-faint hover:text-text disabled:opacity-30 px-1"
                    onClick={() => {
                      const opts = s.options.filter((_: string, j: number) => j !== i);
                      const fix = (c: number) => (c > i ? c - 1 : c);
                      spec({ options: opts, correct: draft.type === 'mcq_single' ? (s.correct === i ? 0 : fix(s.correct)) : s.correct.filter((c: number) => c !== i).map(fix) });
                    }}
                    aria-label="Remove option"
                  >×</button>
                </div>
              );
            })}
            {s.options.length < 10 && <Button size="sm" variant="ghost" onClick={() => spec({ options: [...s.options, ''] })}>Add option</Button>}
          </div>
        </Field>
      )}

      {draft.type === 'true_false' && (
        <Field label="Answer">
          <Segmented value={String(s.correct)} onChange={(v) => spec({ correct: v === 'true' })} options={[{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]} />
        </Field>
      )}

      {draft.type === 'fill_blank' && (
        <Field label="Accepted answers per blank" hint={`Comma-separated alternatives. The prompt has ${blankCount} blank${blankCount === 1 ? '' : 's'}.`}>
          <div className="space-y-2">
            {s.blanks.map((b: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 text-faint text-right">{i + 1}</span>
                <input className="field" value={b.accept.join(', ')} placeholder="answer, alternative" onChange={(e) => { const v = [...s.blanks]; v[i] = { ...b, accept: e.target.value.split(',').map((x) => x.trimStart()) }; spec({ blanks: v }); }} />
                <label className="flex items-center gap-1.5 text-[12px] text-muted whitespace-nowrap">
                  <input type="checkbox" checked={!!b.case_sensitive} onChange={(e) => { const v = [...s.blanks]; v[i] = { ...b, case_sensitive: e.target.checked || undefined }; spec({ blanks: v }); }} /> case
                </label>
                <button type="button" className="text-faint hover:text-text px-1" disabled={s.blanks.length <= 1} onClick={() => spec({ blanks: s.blanks.filter((_: any, j: number) => j !== i) })}>×</button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => spec({ blanks: [...s.blanks, { accept: [''] }] })}>Add blank</Button>
          </div>
        </Field>
      )}

      {draft.type === 'numeric' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Answer"><input className="field font-mono" value={s.answer} onChange={(e) => spec({ answer: e.target.value })} /></Field>
          <Field label="Tolerance" hint={s.relative ? 'fraction, e.g. 0.01 = 1%' : 'absolute'}>
            <div className="flex gap-2 items-center">
              <input className="field font-mono" value={s.tolerance ?? ''} placeholder="exact" onChange={(e) => spec({ tolerance: e.target.value })} />
              <label className="text-[12px] text-muted flex items-center gap-1"><input type="checkbox" checked={!!s.relative} onChange={(e) => spec({ relative: e.target.checked || undefined })} />%</label>
            </div>
          </Field>
          <Field label="Unit"><input className="field" value={s.unit ?? ''} onChange={(e) => spec({ unit: e.target.value })} /></Field>
        </div>
      )}

      {draft.type === 'short_answer' && (
        <>
          <Field label="Model answer"><textarea className="field" rows={4} value={s.model_answer} onChange={(e) => spec({ model_answer: e.target.value })} /></Field>
          <Field label="Rubric" hint="Criteria the grader scores. Score = points earned / total.">
            <div className="space-y-2">
              {(s.rubric ?? []).map((r: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <input className="field" value={r.criterion} placeholder="Criterion" onChange={(e) => { const v = [...s.rubric]; v[i] = { ...r, criterion: e.target.value }; spec({ rubric: v }); }} />
                  <input className="field w-20 font-mono" value={r.points} onChange={(e) => { const v = [...s.rubric]; v[i] = { ...r, points: Number(e.target.value) || 0 }; spec({ rubric: v }); }} />
                  <button type="button" className="text-faint hover:text-text px-1" onClick={() => spec({ rubric: s.rubric.filter((_: any, j: number) => j !== i) })}>×</button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => spec({ rubric: [...(s.rubric ?? []), { criterion: '', points: 1 }] })}>Add criterion</Button>
            </div>
          </Field>
          <label className="flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" checked={!!s.long} onChange={(e) => spec({ long: e.target.checked || undefined })} /> Essay (large answer box)</label>
        </>
      )}

      {draft.type === 'flashcard' && (
        <Field label="Back"><textarea className="field" rows={4} value={s.back} onChange={(e) => spec({ back: e.target.value })} /></Field>
      )}

      <Field label="Tags" hint="Reuse existing tags. Use › or > for hierarchy, e.g. math › calculus › integrals.">
        <TagInput value={draft.tags} onChange={(tags) => set({ tags })} />
      </Field>

      <div className="grid grid-cols-[auto_1fr] gap-5">
        <Field label="Difficulty">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((d) => (
              <button key={d} type="button" onClick={() => set({ difficulty: d })} className={`w-8 h-8 rounded-md border text-[13px] ${draft.difficulty === d ? 'border-accent/60 bg-accent-soft' : 'border-line text-muted hover:border-line-strong'}`}>{d}</button>
            ))}
          </div>
        </Field>
        <Field label="Citation"><input className="field h-8" value={draft.citation} placeholder="Book, chapter, lecture…" onChange={(e) => set({ citation: e.target.value })} /></Field>
      </div>
      {draft.source && (
        <div className="flex items-center gap-3">
          <SourceLine source={draft.source} />
          <button type="button" className="text-[12px] text-faint hover:text-text" onClick={() => set({ source: null })}>Remove link</button>
        </div>
      )}

      <Field label="Explanation" hint="Shown after answering.">
        <textarea className="field" rows={3} value={draft.explanation} onChange={(e) => set({ explanation: e.target.value })} />
      </Field>

      <Field label="Hints" hint="Revealed one at a time with h. Using a hint counts the answer as Hard.">
        <div className="space-y-2">
          {draft.hints.map((h, i) => (
            <div key={i} className="flex gap-2">
              <input className="field" value={h} onChange={(e) => { const v = [...draft.hints]; v[i] = e.target.value; set({ hints: v }); }} />
              <button type="button" className="text-faint hover:text-text px-1" onClick={() => set({ hints: draft.hints.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          {draft.hints.length < 5 && <Button size="sm" variant="ghost" onClick={() => set({ hints: [...draft.hints, ''] })}>Add hint</Button>}
        </div>
      </Field>
    </div>
  );
}

/** Read-only view of a full question with its answer. */
export function QuestionView({ d }: { d: Draft }) {
  const names = useTagNames();
  const s = d.spec;
  return (
    <div>
      <div className="text-[12px] text-faint mb-3">{TYPE_LABELS[d.type]} · difficulty {d.difficulty} · {d.tags.map((t) => tagLabel(t, names)).join(', ') || 'no tags'}</div>
      <Md src={d.prompt || '*Empty question*'} className="text-[15px]" />
      <div className="mt-4 text-[14px]">
        {(d.type === 'mcq_single' || d.type === 'mcq_multi') && (
          <div className="space-y-1.5">
            {s.options.map((o: string, i: number) => {
              const right = d.type === 'mcq_single' ? s.correct === i : s.correct.includes(i);
              return (
                <div key={i} className={`flex gap-2 rounded-lg border px-3 py-2 ${right ? 'border-good/50 bg-good-soft' : 'border-line'}`}>
                  <span className="text-faint w-4">{i + 1}</span><Md src={o || '–'} className="flex-1" />
                </div>
              );
            })}
          </div>
        )}
        {d.type === 'true_false' && <div>Answer: <span className="text-good">{s.correct ? 'True' : 'False'}</span></div>}
        {d.type === 'fill_blank' && <ol className="list-decimal pl-5 space-y-0.5">{s.blanks.map((b: any, i: number) => <li key={i}>{b.accept.filter(Boolean).join(' / ') || '–'}</li>)}</ol>}
        {d.type === 'numeric' && <div className="font-mono">{String(s.answer)} {s.unit}{s.tolerance ? <span className="text-faint"> ± {s.relative ? `${Number(s.tolerance) * 100}%` : s.tolerance}</span> : null}</div>}
        {d.type === 'short_answer' && (
          <div>
            <div className="text-[12px] text-faint mb-1">Model answer</div>
            <Md src={s.model_answer || '–'} />
            {s.rubric?.length > 0 && <ul className="mt-2 text-muted text-[13px]">{s.rubric.map((r: any, i: number) => <li key={i}>· {r.criterion} ({r.points})</li>)}</ul>}
          </div>
        )}
        {d.type === 'flashcard' && <div className="border-t border-line pt-3"><Md src={s.back || '–'} /></div>}
        {d.type === 'cloze' && (
          <div className="text-muted text-[13px]">
            {clozeAnswers(d.prompt).length ? <>Answers: {clozeAnswers(d.prompt).map((a, i) => <span key={i} className="text-good">{i ? ', ' : ''}{a}</span>)}</> : <span className="text-bad">No {'{{c1::…}}'} clozes yet.</span>}
          </div>
        )}
        {d.type === 'matching' && (
          <div className="space-y-1.5">
            {s.pairs.map((p: any, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center rounded-lg border border-line px-3 py-1.5">
                <Md src={p.left || '–'} /><span className="text-faint">→</span><Md src={p.right || '–'} className="text-good" />
              </div>
            ))}
            {s.distractors?.length > 0 && <div className="text-[12.5px] text-faint">Distractors: {s.distractors.join(', ')}</div>}
          </div>
        )}
        {d.type === 'ordering' && <ol className="list-decimal pl-5 space-y-0.5">{s.items.map((it: string, i: number) => <li key={i}><Md src={it || '–'} inline /></li>)}</ol>}
        {d.type === 'code' && (
          <div className="space-y-2">
            <div className="text-[12.5px] text-faint font-mono">{s.language}{s.tests?.length && /^(js|javascript)$/i.test(s.language) ? ` · ${s.tests.length} tests (${s.tests.filter((t: any) => t.hidden).length} hidden)` : ' · graded against reference'}</div>
            {s.starter && <Md src={'```' + s.language + '\n' + s.starter + '\n```'} />}
            {s.reference_solution && <><div className="text-[12px] text-faint">Reference solution</div><Md src={'```' + s.language + '\n' + s.reference_solution + '\n```'} /></>}
          </div>
        )}
        {d.type === 'hotspot' && (s.image ? (
          <div className="relative inline-block max-w-full rounded-lg overflow-hidden border border-line">
            <img src={s.image} alt="" className="block max-w-full max-h-[40vh]" />
            {(s.regions ?? []).map((r: any, i: number) => (
              <div key={i} className="absolute border-2 rounded" title={r.label} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: 'var(--good)', background: 'var(--good-soft)' }} />
            ))}
          </div>
        ) : <div className="text-faint text-[13px]">No image yet.</div>)}
      </div>
      {d.explanation && <div className="mt-4"><div className="text-[12px] text-faint mb-1">Explanation</div><Md src={d.explanation} className="text-muted" /></div>}
      {d.hints.length > 0 && <div className="mt-3 text-[13px] text-muted">{d.hints.length} hint{d.hints.length > 1 ? 's' : ''}</div>}
    </div>
  );
}

interface Detail {
  question: Question;
  versions: { version: number; edit_kind: string; edited_by: string; edited_at: number }[];
  attempts: { id: number; score: number | null; grade_status: string; time_ms: number; confidence: number | null; answered_at: number }[];
  srs: { due: number; state: number; reps: number; lapses: number; card: { stability: number; difficulty: number } } | null;
}

export default function Editor({ id }: { id?: number }) {
  const [, nav] = useLocation();
  const { data } = useApi<Detail>(id ? `/questions/${id}` : null);
  const [draft, setDraft] = useState<Draft | null>(id ? null : { type: 'mcq_single', prompt: '', tags: [], difficulty: 3, explanation: '', hints: [], citation: '', source: null, spec: DEFAULT_SPEC.mcq_single });
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => { if (data && !draft) setDraft(toDraft(data.question)); }, [data, draft]);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setIssues([]);
    try {
      if (id) {
        const r = await api.patch<{ edit_kind: string; schedule_reset: boolean }>(`/questions/${id}`, toPayload(draft));
        toast(r.schedule_reset ? 'Saved. Answer changed, so its review schedule was reset.' : 'Saved', 'good');
        invalidate(`/questions`);
      } else {
        const [r] = await api.post<any[]>('/questions', [toPayload(draft)]);
        if (r.status === 'created') {
          toast(r.near_duplicates ? 'Created, but it looks similar to an existing question.' : 'Created', 'good');
          invalidate('/questions', '/home', '/tags');
          nav(`/library/${r.id}`, { replace: true });
        } else if (r.status === 'invalid') setIssues(r.errors);
        else if (r.status === 'duplicate') setIssues(r.duplicate_of.map((d: any) => `Duplicate of #${d.id} (${Math.round(d.similarity * 100)}% similar): ${d.prompt}`));
        else if (r.status === 'unresolved_tags') setIssues(r.tags.map((t: any) => `Unknown tag “${t.input}”${t.suggestions.length ? ` — did you mean ${t.suggestions.map((s: any) => s.path).join(', ')}?` : ''}`));
      }
    } catch (e: any) {
      setIssues([e.message, ...(Array.isArray(e.details) ? e.details.map((d: any) => d.message ?? JSON.stringify(d)) : [])]);
    } finally {
      setSaving(false);
    }
  };

  const status = async (st: string) => {
    await api.post('/questions/status', { ids: [id], status: st });
    invalidate('/questions', '/home');
    toast(`Question ${st === 'active' ? 'activated' : st}`);
  };

  useKeys({ 'mod+s': save, 'mod+Enter': save, Escape: () => nav('/library') }, { allowInInput: ['Escape'] });

  if (!draft) return null;
  const q = data?.question;

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => nav('/library')} className="text-muted hover:text-text text-[13px]">← Library</button>
          <h1 className="text-[17px] font-semibold">{id ? `Question #${id}` : 'New question'}</h1>
          {q && q.status !== 'active' && <Badge>{q.status}</Badge>}
          {q?.flagged_reason && <Badge tone="warn">flagged: {q.flagged_reason}</Badge>}
        </div>
        <div className="flex gap-2">
          {q?.flagged_reason && <Button size="sm" onClick={async () => { await api.post(`/questions/${id}/flag`, { reason: null }); invalidate('/questions', '/home'); }}>Clear flag</Button>}
          {q && q.status !== 'active' && <Button size="sm" onClick={() => status('active')}>Activate</Button>}
          {q && q.status === 'active' && <Button size="sm" variant="ghost" onClick={() => status('suspended')}>Suspend</Button>}
          {q && q.status !== 'archived' && <Button size="sm" variant="danger" onClick={() => status('archived')}>Archive</Button>}
          <Button variant="primary" onClick={save} disabled={saving} kbd="Ctrl S">{id ? 'Save' : 'Create'}</Button>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="mb-5 rounded-lg border border-bad/40 bg-bad-soft px-4 py-3 text-[13px] text-bad space-y-1">
          {issues.map((i, k) => <div key={k}>{i}</div>)}
        </div>
      )}
      {q?.near_duplicate_of && (
        <div className="mb-5 rounded-lg border border-line px-4 py-3 text-[13px] text-muted">
          Similar to {q.near_duplicate_of.map((n, i) => <span key={n}>{i ? ', ' : ''}<a className="text-accent" href={`/library/${n}`}>#{n}</a></span>)}. Archive one if they test the same thing.
        </div>
      )}

      <div className="grid grid-cols-2 gap-8 max-lg:grid-cols-1">
        <QuestionForm draft={draft} onChange={setDraft} />
        <div className="space-y-6">
          <Card className="p-5 sticky top-4">
            <div className="text-[12px] text-faint mb-3 flex justify-between"><span>Preview</span><span>with answer</span></div>
            <QuestionView d={draft} />
          </Card>
          {data && <History data={data} onRestore={async (v) => { await api.post(`/questions/${id}/restore`, { version: v }); setDraft(null); invalidate(`/questions/${id}`); toast(`Restored version ${v}`); }} />}
        </div>
      </div>
    </div>
  );
}

function History({ data, onRestore }: { data: Detail; onRestore: (v: number) => void }) {
  const STATE = ['New', 'Learning', 'Review', 'Relearning'];
  const [tab, setTab] = useState<'stats' | 'versions'>('stats');
  const graded = data.attempts.filter((a) => a.score !== null);
  const acc = graded.length ? graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length : null;
  return (
    <Card className="p-5">
      <Segmented value={tab} onChange={setTab} options={[{ value: 'stats', label: 'Performance' }, { value: 'versions', label: `Versions · ${data.versions.length}` }]} />
      {tab === 'stats' ? (
        <div className="mt-4 text-[13px]">
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div><div className="text-faint text-[12px]">Answers</div><div className="text-[16px] tabular-nums">{data.attempts.length}</div></div>
            <div><div className="text-faint text-[12px]">Accuracy</div><div className="text-[16px] tabular-nums">{pct(acc)}</div></div>
            <div><div className="text-faint text-[12px]">State</div><div className="text-[16px]">{data.srs ? STATE[data.srs.state] : 'New'}</div></div>
            <div><div className="text-faint text-[12px]">Next review</div><div className="text-[16px]">{data.srs ? (data.srs.due < Date.now() ? 'due' : fmtDue(data.srs.due)) : '–'}</div></div>
          </div>
          {data.srs && <div className="text-faint text-[12px] mb-3">Stability {data.srs.card.stability.toFixed(1)} d · FSRS difficulty {data.srs.card.difficulty.toFixed(1)} · {data.srs.lapses} lapses</div>}
          {data.attempts.slice(0, 8).map((a) => (
            <div key={a.id} className="flex justify-between py-1.5 border-t border-line">
              <span className="text-muted">{ago(a.answered_at)}</span>
              <span className="text-faint">{fmtMs(a.time_ms)}{a.confidence ? ` · conf ${a.confidence}` : ''}</span>
              <span className={a.score === null ? 'text-faint' : a.score >= 0.8 ? 'text-good' : 'text-bad'}>{a.score === null ? 'pending' : pct(a.score)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 text-[13px]">
          {[...data.versions].reverse().map((v) => (
            <div key={v.version} className="flex items-center justify-between py-1.5 border-t border-line first:border-0">
              <span>v{v.version} <span className="text-faint">· {v.edit_kind} · {v.edited_by.replace('agent:', 'agent ')} · {ago(v.edited_at)}</span></span>
              {v.version !== data.question.version && <button className="text-accent text-[12.5px]" onClick={() => onRestore(v.version)}>Restore</button>}
            </div>
          ))}
          <div className="text-faint text-[12px] mt-3"><Kbd>Ctrl S</Kbd> saves. Changing the answer resets the schedule.</div>
        </div>
      )}
    </Card>
  );
}

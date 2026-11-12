import { useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, invalidate, tagLabel, useTagNames, TYPE_LABELS, type QType } from '../lib/api';
import { MdLine } from '../lib/md';
import { Button, Card, PageHeader, Badge, Field, toast } from '../components/ui';
import { TagInput } from '../components/TagInput';

type Format = 'apkg' | 'csv' | 'markdown' | 'socrates';
interface Suggestion { id: number; path: string; name: string; score: number; reason: string }
interface TagPlan { path: string; status: 'exists' | 'new' | 'similar'; target: string | null; suggestions: Suggestion[]; count: number }
interface Preview {
  token: string; name: string; format: Format; total: number; by_type: Record<string, number>;
  sample: { type: QType; prompt: string; back?: string; tags: string[] }[];
  tags: TagPlan[]; images: number; errors: { where: string; message: string }[]; error_count: number; warnings: string[];
}
interface Result {
  created: number; duplicate: number; exists: number; invalid: number; skipped_tags: number;
  tags_created: string[]; tag_errors: string[]; parse_errors: number; missing_images: number;
  problems: { index: number; status: string; message: string; prompt: string }[];
}
interface Options { tags: string[]; deck_tags: boolean; note_tags: boolean }

const FORMAT_LABEL: Record<Format, string> = { apkg: 'Anki deck', csv: 'CSV', markdown: 'Markdown', socrates: 'Socrates export' };

const MD_EXAMPLE = `Tags: Biology > Cells
---
Q: What is the powerhouse of the cell?
A: The mitochondrion
E: It makes most of the cell's ATP.
---
## Which are organelles?
- [x] Ribosome
- [ ] Cytoplasm
- [x] Nucleus
---
The membrane is a {{c1::phospholipid}} bilayer.`;

/** Upload a file, review what will be created (tags especially), then import. */
export default function Import() {
  const [file, setFile] = useState<{ token: string; name: string; format: Format } | null>(null);
  const [opts, setOpts] = useState<Options>({ tags: [], deck_tags: true, note_tags: true });
  const [pv, setPv] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'upload' | 'preview' | 'import'>('');
  const [result, setResult] = useState<Result | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const names = useTagNames();

  const refresh = async (token: string, o: Options) => {
    setBusy('preview');
    try {
      const p = await api.post<Preview>('/import/preview', { token, options: o });
      setPv(p);
      setMap(Object.fromEntries(p.tags.filter((t) => t.status === 'similar').map((t) => [t.path, t.target!])));
    } catch (e: any) { toast(e.message, 'bad'); setPv(null); }
    finally { setBusy(''); }
  };

  const choose = async (f: File) => {
    setResult(null); setPv(null); setBusy('upload');
    try {
      const r = await fetch(`/api/import/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      setFile(data);
      await refresh(data.token, opts);
    } catch (e: any) { toast(e.message, 'bad'); setBusy(''); }
  };

  const setOption = (o: Options) => { setOpts(o); if (file) refresh(file.token, o); };

  const run = async () => {
    if (!pv) return;
    setBusy('import');
    try {
      const r = await api.post<Result>('/import/commit', { token: pv.token, options: opts, tag_map: map });
      setResult(r); setPv(null); setFile(null);
      invalidate('/questions', '/home', '/tags');
    } catch (e: any) { toast(e.message, 'bad'); }
    finally { setBusy(''); }
  };

  const fresh = pv ? pv.tags.filter((t) => t.status !== 'exists') : [];
  const reused = pv ? pv.tags.filter((t) => t.status === 'exists') : [];

  return (
    <div className="fade-in max-w-3xl">
      <PageHeader title="Import" sub="Anki decks, CSV or TSV, Markdown, or a Socrates export. Nothing is added until you confirm." />

      {result ? (
        <Card className="p-6 space-y-4">
          <div>
            <div className="text-[15px] font-medium">{result.created ? `Imported ${result.created} question${result.created === 1 ? '' : 's'}` : 'Nothing new to import'}</div>
            <div className="text-muted mt-1 text-[13px]">
              {[
                result.duplicate && `${result.duplicate} already in your library (or too similar)`,
                result.exists && `${result.exists} imported before`,
                result.invalid + result.skipped_tags && `${result.invalid + result.skipped_tags} could not be added`,
                result.parse_errors && `${result.parse_errors} skipped while reading`,
                result.missing_images && `${result.missing_images} image${result.missing_images === 1 ? '' : 's'} missing`,
              ].filter(Boolean).join(' · ') || 'Everything was added.'}
            </div>
          </div>
          {result.tags_created.length > 0 && (
            <div className="text-[13px]"><span className="text-muted">New tags: </span>{result.tags_created.map((t) => tagLabel(t, names)).join(', ')}</div>
          )}
          {[...result.tag_errors, ...result.problems.map((p) => `${p.prompt}: ${p.message}`)].slice(0, 10).map((m, i) => (
            <div key={i} className="text-[12.5px] text-bad">{m}</div>
          ))}
          <div className="flex gap-2">
            <Link href="/library"><Button variant="primary">Open library</Button></Link>
            <Button onClick={() => setResult(null)}>Import another file</Button>
          </div>
        </Card>
      ) : (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) choose(f); }}
            onClick={() => input.current?.click()}
            className={`rounded-xl border border-dashed px-6 py-8 text-center cursor-pointer transition-colors ${drag ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-hover'}`}
          >
            <input ref={input} type="file" className="hidden" accept=".apkg,.colpkg,.csv,.tsv,.txt,.md,.markdown,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
            {busy === 'upload' ? <div className="text-muted">Reading file…</div> : file ? (
              <div><span className="font-medium">{file.name}</span> <span className="text-muted">· {FORMAT_LABEL[file.format]} · click or drop to choose another</span></div>
            ) : (
              <>
                <div className="font-medium">Drop a file here, or click to choose</div>
                <div className="text-muted text-[12.5px] mt-1">.apkg · .csv · .tsv · .txt · .md · .json</div>
              </>
            )}
          </div>

          {!file && <Formats />}

          {file && (
            <Card className="p-5 mt-4 space-y-4">
              <Field label="Add these tags to every question" hint="Optional. Questions with no tags of their own go under “Imported”.">
                <TagInput value={opts.tags} onChange={(tags) => setOption({ ...opts, tags })} />
              </Field>
              {file.format === 'apkg' && (
                <div className="flex gap-6 text-[13px]">
                  <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--accent)]" checked={opts.deck_tags} onChange={(e) => setOption({ ...opts, deck_tags: e.target.checked })} /> Deck name as a tag</label>
                  <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--accent)]" checked={opts.note_tags} onChange={(e) => setOption({ ...opts, note_tags: e.target.checked })} /> Keep Anki tags</label>
                </div>
              )}
            </Card>
          )}

          {pv && (
            <div className={`mt-6 space-y-6 ${busy === 'preview' ? 'opacity-60' : ''}`}>
              <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-[15px] font-medium">{pv.total} question{pv.total === 1 ? '' : 's'} found</div>
                  <div className="text-muted text-[13px] mt-0.5">
                    {Object.entries(pv.by_type).map(([t, n]) => `${TYPE_LABELS[t as QType] ?? t} ${n}`).join(' · ')}
                    {pv.images > 0 && ` · ${pv.images} image${pv.images === 1 ? '' : 's'}`}
                  </div>
                </div>
                <Button variant="primary" onClick={run} disabled={!pv.total || !!busy}>{busy === 'import' ? 'Importing…' : `Import ${pv.total}`}</Button>
              </div>

              {pv.warnings.map((w, i) => <div key={i} className="text-[13px] text-warn">{w}</div>)}

              {fresh.length > 0 && (
                <section>
                  <h2 className="font-medium mb-1">Tags to check</h2>
                  <p className="text-muted text-[13px] mb-3">Where a tag looks like one you already have, the existing tag is used. Switch to “Create new” if they really are different.</p>
                  <Card className="divide-y divide-line">
                    {fresh.map((t) => (
                      <div key={t.path} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px] flex-wrap">
                        <div className="min-w-0">
                          <span className="font-medium">{t.path.split(' > ').join(' › ')}</span>
                          <span className="text-faint"> · {t.count}</span>
                        </div>
                        {t.status === 'new' ? <Badge>New tag</Badge> : (
                          <select
                            className="field h-8 py-0 text-[12.5px] w-auto max-w-[60%] max-sm:max-w-full"
                            value={map[t.path] ?? 'create'}
                            onChange={(e) => setMap({ ...map, [t.path]: e.target.value })}
                          >
                            {t.suggestions.map((s) => <option key={s.id} value={s.path}>Use {tagLabel(s.path, names)} ({s.reason})</option>)}
                            <option value="create">Create new</option>
                          </select>
                        )}
                      </div>
                    ))}
                  </Card>
                </section>
              )}
              {reused.length > 0 && (
                <div className="text-[13px] text-muted">Existing tags reused: {reused.map((t) => tagLabel(t.target ?? t.path, names)).join(', ')}</div>
              )}

              <section>
                <h2 className="font-medium mb-3">First questions</h2>
                <Card className="divide-y divide-line">
                  {pv.sample.map((s, i) => (
                    <div key={i} className="px-4 py-2.5 text-[13px] grid grid-cols-[1fr_auto] gap-3">
                      <div className="min-w-0">
                        <MdLine src={s.prompt} />
                        {s.back && <div className="text-muted mt-0.5"><MdLine src={s.back} /></div>}
                      </div>
                      <span className="text-faint text-[12px] whitespace-nowrap">{TYPE_LABELS[s.type] ?? s.type}</span>
                    </div>
                  ))}
                </Card>
              </section>

              {pv.error_count > 0 && (
                <section>
                  <h2 className="font-medium mb-1">Skipped ({pv.error_count})</h2>
                  <Card className="divide-y divide-line max-h-56 overflow-y-auto">
                    {pv.errors.map((e, i) => (
                      <div key={i} className="px-4 py-2 text-[12.5px] flex gap-3"><span className="text-faint w-20 shrink-0">{e.where}</span><span className="text-muted">{e.message}</span></div>
                    ))}
                  </Card>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Formats() {
  return (
    <div className="mt-8 grid grid-cols-2 gap-4 max-md:grid-cols-1 text-[13px]">
      <Card className="p-5">
        <div className="font-medium mb-1">Anki (.apkg)</div>
        <p className="text-muted">Basic and cloze notes, with images, formatting and MathJax. Deck names and Anki tags become tags. Importing the same deck again only adds new notes. Review history stays in Anki.</p>
      </Card>
      <Card className="p-5">
        <div className="font-medium mb-1">CSV or TSV</div>
        <p className="text-muted">Two columns (question, answer) work. With a header row, Socrates also reads <code className="font-mono">tags</code>, <code className="font-mono">explanation</code>, <code className="font-mono">type</code> (flashcard, mcq, tf, numeric, written) and <code className="font-mono">options</code> (separated by |).</p>
      </Card>
      <Card className="p-5 col-span-2 max-md:col-span-1">
        <div className="font-medium mb-1">Markdown</div>
        <p className="text-muted mb-3">Questions separated by <code className="font-mono">---</code>. Use <code className="font-mono">Q:</code>/<code className="font-mono">A:</code> or a heading with the answer under it, checkboxes for multiple choice, and <code className="font-mono">{'{{c1::…}}'}</code> for cloze.</p>
        <pre className="font-mono text-[12px] bg-elev border border-line rounded-lg px-3 py-2.5 overflow-x-auto">{MD_EXAMPLE}</pre>
      </Card>
    </div>
  );
}

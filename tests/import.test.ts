process.env.SOCRATES_EMBEDDINGS ??= 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
process.env.SOCRATES_MEDIA ??= mkdtempSync(join(tmpdir(), 'socr-import-media-'));
const { App } = await import('../src/core/app.ts');
const { upload, preview, commit, parseCsvRows, parseMarkdown, htmlToMd, exportJson } = await import('../src/core/importer.ts');
const { saveImage } = await import('../src/core/media.ts');
/** 1x1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const fresh = () => new App(':memory:');

/** Tiny zip writer (deflate), for building test .apkg files. */
function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [], dir: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data), n = Buffer.from(name), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, comp); dir.push(c, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(dir.length / 2, 8); e.writeUInt16LE(dir.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

/** A legacy-schema Anki collection with one basic note, one cloze note and an image. */
function apkg(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'socr-apkg-'));
  const path = join(dir, 'c.anki2');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE col (id integer primary key, models text, decks text);
           CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
           CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer);`);
  db.prepare('INSERT INTO col VALUES (1, ?, ?)').run(
    JSON.stringify({ 10: { id: 10, name: 'Basic', type: 0, flds: [{ name: 'Front' }, { name: 'Back' }] }, 20: { id: 20, name: 'Cloze', type: 1, flds: [{ name: 'Text' }, { name: 'Back Extra' }] } }),
    JSON.stringify({ 1: { id: 1, name: 'Default' }, 5: { id: 5, name: 'Chemistry::Elements' } }),
  );
  const note = db.prepare('INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, 0, ?)');
  note.run(100, 'g1', 10, ' periodic_table ', 'What is the symbol for <b>gold</b>?<br><img src="gold.png">\x1fAu &amp; it is \\(Z = 79\\)', '', '');
  note.run(101, 'g2', 20, '', 'Water is {{c1::H2O}}.\x1fFormula', '', '');
  db.prepare('INSERT INTO cards VALUES (1, 100, 5, 0), (2, 101, 5, 0)').run();
  db.close();
  const out = zip({ 'collection.anki2': readFileSync(path), media: Buffer.from(JSON.stringify({ 0: 'gold.png' })), 0: PNG });
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('CSV: delimiter detection, quotes, headers and typed rows', async () => {
  assert.deepEqual(parseCsvRows('a,"b, with ""quotes"""\n1,2\n'), [['a', 'b, with "quotes"'], ['1', '2']]);
  assert.deepEqual(parseCsvRows('#separator:tab\nx\ty\n'), [['x', 'y']]);
  const app = fresh();
  const csv = 'Question,Answer,Tags,Type,Options\nCapital of France?,Paris,Geography > Capitals,,\n2+2?,4,Math,numeric,\nBest planet?,b,Space,mcq,Mars|Earth|Venus\nSky is green?,false,Science,tf,\n,,,\nBroken,x,Math,numeric,\n';
  const u = upload('cards.csv', Buffer.from(csv));
  const p = preview(app.tags, u.token);
  assert.equal(p.total, 4);
  assert.deepEqual(p.by_type, { flashcard: 1, numeric: 1, mcq_single: 1, true_false: 1 });
  assert.equal(p.error_count, 1, 'non-numeric answer (blank rows are skipped)');
  assert.ok(p.tags.every((t) => t.status === 'new'));
  const r = await commit(app, u.token);
  assert.equal(r.created, 4);
  assert.ok(r.tags_created.length >= 4);
  const mcq = app.questions.search({ query: 'planet' }).items[0];
  assert.equal(mcq.spec.correct, 1);
});

test('Markdown: Q/A blocks, headings, options, default tags and cloze', () => {
  const md = [
    'Tags: Biology > Cells',
    '---',
    'Q: What is the powerhouse of the cell?',
    'A: The mitochondrion',
    'E: It makes ATP.',
    '---',
    '## Which are organelles?',
    '- [x] Ribosome',
    '- [ ] Cytoplasm',
    '- [x] Nucleus',
    '---',
    'The cell membrane is made of a {{c1::phospholipid}} bilayer.',
    '---',
    'Q: Show code',
    '```',
    'A: not an answer line',
    '---',
    '```',
    'A: done',
  ].join('\n');
  const p = parseMarkdown(md, 'notes.md');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.items.map((i) => i.type), ['flashcard', 'mcq_multi', 'cloze', 'flashcard']);
  assert.deepEqual(p.items[1].correct, [0, 2]);
  assert.equal(p.items[0].explanation, 'It makes ATP.');
  assert.deepEqual(p.items[2].tags, ['Biology > Cells']);
  assert.ok(String(p.items[3].prompt).includes('A: not an answer line'), 'markers inside code fences are text');
  assert.equal(p.items[3].back, 'done');
});

test('Anki: notes, cloze, deck and note tags, images, HTML and MathJax', async () => {
  assert.equal(htmlToMd('<div>a&nbsp;<i>b</i></div><div>\\[x^2\\]</div>', () => null), 'a *b*\n$$x^2$$');
  const app = fresh();
  app.tags.create('Chemistry > Element'); // the importer should reuse it for "Chemistry::Elements"
  const u = upload('deck.apkg', apkg());
  const p = preview(app.tags, u.token);
  assert.equal(p.total, 2);
  assert.equal(p.images, 1);
  const deck = p.tags.find((t) => t.path === 'Chemistry > Elements')!;
  assert.equal(deck.status, 'exists', 'plural variant resolves to the existing tag');
  assert.ok(p.tags.some((t) => t.path === 'periodic table'));
  const r = await commit(app, u.token);
  assert.equal(r.created, 2);
  const gold = app.questions.search({ query: 'gold' }).items[0];
  assert.match(gold.prompt, /What is the symbol for \*\*gold\*\*\?\n!\[\]\(\/media\/[a-f0-9]{32}\.png\)/);
  assert.equal(gold.spec.back, 'Au & it is $Z = 79$');
  const cloze = app.questions.search({ type: ['cloze'] as any }).items[0];
  assert.equal(cloze.explanation, 'Formula');
  // Importing the same deck again is idempotent (client_ref per note guid).
  const again = await commit(app, upload('deck.apkg', apkg()).token);
  assert.equal(again.created, 0);
  assert.equal(again.exists, 2);
});

test('Anki: the newer export format (zstd, notetype tables, protobuf media index)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'socr-apkg21b-'));
  const path = join(dir, 'c.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE col (id integer primary key, models text, decks text);
           CREATE TABLE decks (id integer primary key, name text);
           CREATE TABLE notetypes (id integer primary key, name text);
           CREATE TABLE fields (ntid integer, ord integer, name text);
           CREATE TABLE notes (id integer primary key, guid text, mid integer, tags text, flds text);
           CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer);
           INSERT INTO col VALUES (1, '', '');
           INSERT INTO decks VALUES (7, 'Languages' || char(31) || 'Spanish');
           INSERT INTO notetypes VALUES (3, 'Basic');
           INSERT INTO fields VALUES (3, 0, 'Front'), (3, 1, 'Back');
           INSERT INTO notes VALUES (1, 'n1', 3, 'vocab', 'el perro<img src="dog.png">' || char(31) || 'the dog');
           INSERT INTO cards VALUES (1, 1, 7, 0);`);
  db.close();
  const name = Buffer.from('dog.png');
  const entry = Buffer.concat([Buffer.from([0x0a, name.length]), name, Buffer.from([0x10, PNG.length])]);
  const index = Buffer.concat([Buffer.from([0x0a, entry.length]), entry]);
  const file = zip({ 'collection.anki21b': zstdCompressSync(readFileSync(path)), media: zstdCompressSync(index), 0: zstdCompressSync(PNG) });
  rmSync(dir, { recursive: true, force: true });
  const app = fresh();
  const u = upload('new.apkg', file);
  const p = preview(app.tags, u.token);
  assert.deepEqual(p.tags.map((t) => t.path).sort(), ['Languages > Spanish', 'vocab']);
  assert.equal(p.images, 1);
  assert.equal((await commit(app, u.token)).created, 1);
  assert.match(app.questions.search({ query: 'perro' }).items[0].prompt, /^el perro!\[\]\(\/media\/[a-f0-9]{32}\.png\)$/);
});

test('Similar tags map onto the existing tag unless told to create', async () => {
  const app = fresh();
  app.tags.create('Mathematics > Calculus');
  const csv = 'front,back,tags\nd/dx x^2?,2x,Mathematics > Calculas\n';
  const p = preview(app.tags, upload('a.csv', Buffer.from(csv)).token);
  assert.equal(p.tags[0].status, 'similar');
  const r = await commit(app, p.token);
  assert.equal(r.created, 1);
  assert.equal(r.tags_created.length, 0, 'typo mapped onto the existing tag');
  const p2 = preview(app.tags, upload('b.csv', Buffer.from('front,back,tags\nAnother one?,yes,Mathematics > Calculas\n')).token);
  const r2 = await commit(app, p2.token, {}, { 'Mathematics > Calculas': 'create' });
  assert.equal(r2.tags_created.length, 1);
});

test('Socrates export round-trips into a new database', async () => {
  const a = fresh();
  a.tags.create('Physics > Mechanics');
  a.tags.addAlias(a.tags.resolve('Physics > Mechanics').tag_id!, 'Classical mechanics');
  const url = saveImage(PNG).url;
  const img = a.questions.add([{ type: 'flashcard', prompt: 'Shapes\n\n![s](' + url + ')', back: 'b', tags: ['Physics > Mechanics'] }]);
  assert.equal(img[0].status, 'created');
  a.questions.add([
    { type: 'numeric', prompt: 'g on Earth in m/s²?', answer: 9.81, tolerance: 0.05, tags: ['Physics > Mechanics'] },
    { type: 'mcq_single', prompt: 'Unit of force?', options: ['Newton', 'Joule'], correct: 0, tags: ['Physics > Mechanics'], explanation: 'F = ma' },
  ]);
  const data = exportJson(a.db);
  assert.equal(data.questions.length, 3);
  assert.equal(Object.keys(data.media).length, 1, 'referenced image is embedded');
  const b = fresh();
  const u = upload('export.json', Buffer.from(JSON.stringify(data)));
  const r = await commit(b, u.token);
  assert.equal(r.created, 3);
  assert.ok(b.tags.resolve('Physics > Classical mechanics').tag_id, 'aliases come along');
  const n = b.questions.search({ query: 'Earth' }).items[0];
  assert.equal(n.spec.tolerance, 0.05);
  assert.ok(b.questions.search({ query: 'Shapes' }).items[0].prompt.includes(url), 'image keeps its content-hash URL');
  // and again: nothing new
  assert.equal((await commit(b, upload("export.json", Buffer.from(JSON.stringify(data))).token)).created, 0);
});

test('Cloze pipes: math and escapes are not alternatives; Anki pipes stay literal', async () => {
  const { clozeParts } = await import('../src/core/qtypes.ts');
  assert.deepEqual(clozeParts('{{c1::$|x|$|abs x}}')[0].accept, ['$|x|$', 'abs x']);
  assert.deepEqual(clozeParts('{{c1::a\\|b|c}}')[0].accept, ['a|b', 'c']);
  const { parse } = await import('../src/core/importer.ts');
  const dir = mkdtempSync(join(tmpdir(), 'socr-apkg-pipe-'));
  const path = join(dir, 'c.anki2');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE col (id integer primary key, models text, decks text);
           CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
           CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer);`);
  db.prepare('INSERT INTO col VALUES (1, ?, ?)').run(JSON.stringify({ 20: { id: 20, name: 'Cloze', type: 1, flds: [{ name: 'Text' }] } }), '{}');
  db.prepare(`INSERT INTO notes VALUES (1, 'p', 20, 0, 0, '', 'Unix pipe: {{c1::a | b}}', '', 0, 0, '')`).run();
  db.close();
  const p = parse('apkg', zip({ 'collection.anki2': readFileSync(path) }), 'x.apkg');
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(clozeParts(p.items[0].prompt)[0].accept, ['a | b']);
});

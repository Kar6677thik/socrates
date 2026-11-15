import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = process.env.SOCRATES_DATA ?? join(ROOT, 'data');
export const DEFAULT_DB_PATH = join(DATA_DIR, 'socrates.db');

/** Ordered migrations. Never edit an applied one; append a new entry. */
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    parent_id INTEGER REFERENCES tags(id),
    path TEXT NOT NULL,              -- slug path, e.g. math/calculus/integral
    description TEXT,
    created_by TEXT NOT NULL DEFAULT 'user',
    force_reason TEXT,               -- set when an agent forced creation past a fuzzy match
    merged_into_id INTEGER REFERENCES tags(id),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX tags_path ON tags(path) WHERE merged_into_id IS NULL;
  CREATE INDEX tags_parent ON tags(parent_id);

  CREATE TABLE tag_aliases (
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    alias_slug TEXT NOT NULL,
    parent_path TEXT NOT NULL DEFAULT '',  -- alias is scoped to the tag's parent
    PRIMARY KEY (parent_path, alias_slug)
  );

  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    spec TEXT NOT NULL,              -- JSON: type-specific fields incl. answer
    explanation TEXT,
    hints TEXT NOT NULL DEFAULT '[]',
    difficulty INTEGER NOT NULL DEFAULT 3,   -- seed label 1..5
    irt_b REAL,                      -- calibrated difficulty (phase 2)
    source TEXT,
    group_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',   -- draft|active|suspended|archived
    flagged_reason TEXT,
    near_duplicate_of TEXT,          -- JSON array of ids
    content_hash TEXT NOT NULL,
    client_ref TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX questions_client_ref ON questions(client_ref) WHERE client_ref IS NOT NULL;
  CREATE INDEX questions_hash ON questions(content_hash);
  CREATE INDEX questions_status ON questions(status);

  CREATE VIRTUAL TABLE questions_fts USING fts5(prompt, body, tokenize='porter unicode61');

  CREATE TABLE question_versions (
    question_id INTEGER NOT NULL REFERENCES questions(id),
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    edit_kind TEXT,
    edited_by TEXT,
    edited_at INTEGER NOT NULL,
    PRIMARY KEY (question_id, version)
  );

  CREATE TABLE question_tags (
    question_id INTEGER NOT NULL REFERENCES questions(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (question_id, tag_id)
  );
  CREATE INDEX question_tags_tag ON question_tags(tag_id);

  CREATE TABLE srs_cards (
    question_id INTEGER PRIMARY KEY REFERENCES questions(id),
    card TEXT NOT NULL,              -- ts-fsrs card JSON
    due INTEGER NOT NULL,
    state INTEGER NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_review INTEGER
  );
  CREATE INDEX srs_due ON srs_cards(due);

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    config TEXT NOT NULL,
    queue TEXT NOT NULL,             -- JSON array of question ids
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    question_version INTEGER NOT NULL,
    session_id INTEGER REFERENCES sessions(id),
    response TEXT NOT NULL,
    is_correct INTEGER,              -- null while pending
    score REAL,
    grade_status TEXT NOT NULL,      -- auto|self|pending|graded
    confidence INTEGER,              -- 1..4
    hints_used INTEGER NOT NULL DEFAULT 0,
    time_ms INTEGER NOT NULL,
    first_input_ms INTEGER,
    answer_changes INTEGER NOT NULL DEFAULT 0,
    shown_at INTEGER NOT NULL,
    answered_at INTEGER NOT NULL,
    local_hour INTEGER NOT NULL,
    weekday INTEGER NOT NULL,
    study_day TEXT NOT NULL,         -- YYYY-MM-DD, day starts at 4am
    rating INTEGER,
    srs_before TEXT                  -- card JSON before this attempt (for undo)
  );
  CREATE INDEX attempts_question ON attempts(question_id);
  CREATE INDEX attempts_day ON attempts(study_day);
  CREATE INDEX attempts_pending ON attempts(grade_status) WHERE grade_status = 'pending';

  CREATE TABLE attempt_events (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id),
    t_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX attempt_events_attempt ON attempt_events(attempt_id);

  CREATE TABLE grades (
    id INTEGER PRIMARY KEY,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id),
    score REAL NOT NULL,
    feedback TEXT,
    rubric_scores TEXT,
    grader TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE ability (
    tag_id INTEGER PRIMARY KEY REFERENCES tags(id),
    theta REAL NOT NULL DEFAULT 0,
    n INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,             -- user|agent:<client>
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    result TEXT NOT NULL,
    undo TEXT,                       -- JSON describing how to revert, null if not revertible
    reverted_at INTEGER
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* 2: adaptive engine, embeddings, undo */ `
  ALTER TABLE questions ADD COLUMN irt_n INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE questions ADD COLUMN embedding BLOB;
  ALTER TABLE attempts ADD COLUMN r_pred REAL;          -- FSRS recall probability when shown
  ALTER TABLE attempts ADD COLUMN p_pred REAL;          -- engine's predicted P(correct)
  ALTER TABLE attempts ADD COLUMN elapsed_days REAL;    -- days since previous review
  ALTER TABLE attempts ADD COLUMN engine_before TEXT;   -- ability/difficulty before this attempt (undo)
  `,
];

export function openDb(path = DEFAULT_DB_PATH): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const fresh = path === ':memory:' || !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;
           PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;`);
  migrate(db, path, fresh);
  return db;
}

function migrate(db: DB, path: string, fresh: boolean) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current >= MIGRATIONS.length) return;
  if (!fresh && current > 0) backup(db, path, `pre-migration-v${current}`);
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Run fn in a transaction (nested calls join the outer one). */
let depth = 0;
export function tx<T>(db: DB, fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

/**
 * Snapshot the DB into data/backups using VACUUM INTO, check the copy with PRAGMA integrity_check, and record
 * the outcome in backups/backup-status.json (the off-node backup job ships copies only after a success).
 * Keeps the newest 14 daily files. A copy that fails the check is deleted and the error rethrown.
 */
export function backup(db: DB, dbPath = DEFAULT_DB_PATH, label?: string): string | null {
  if (dbPath === ':memory:') return null;
  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = join(dir, `socrates-${stamp}${label ? '-' + label : ''}.db`);
  const status = (state: 'Succeeded' | 'Failed', extra: Record<string, unknown>) =>
    writeFileSync(join(dir, 'backup-status.json'), JSON.stringify({ state, at: new Date().toISOString(), ...extra }));
  try {
    if (existsSync(file)) unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(file, { readOnly: true });
    let check: string;
    try {
      check = (copy.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check).join('; ');
    } finally {
      copy.close();
    }
    if (check !== 'ok') {
      unlinkSync(file);
      throw new Error(`Backup copy failed its integrity check: ${check.slice(0, 500)}`);
    }
    status('Succeeded', { file: basename(file), bytes: statSync(file).size });
  } catch (e: any) {
    try { status('Failed', { error: String(e?.message ?? e).slice(0, 500) }); } catch {}
    throw e;
  }
  const daily = readdirSync(dir)
    .filter((f) => /^socrates-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
  for (const f of daily.slice(14)) unlinkSync(join(dir, f));
  return file;
}

/** Daily backup if the newest one is older than 24h. */
export function backupIfDue(db: DB, dbPath = DEFAULT_DB_PATH) {
  if (dbPath === ':memory:') return;
  const dir = join(dirname(dbPath), 'backups');
  const stamp = new Date().toISOString().slice(0, 10);
  const today = join(dir, `socrates-${stamp}.db`);
  if (existsSync(today) && Date.now() - statSync(today).mtimeMs < 864e5) return;
  backup(db, dbPath);
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export const now = () => Date.now();

/**
 * Put a list of ids in a temp table and return a subquery over it, for `IN (...)`.
 * Inlined lists of thousands of ids are slow to parse and plan on every query.
 */
export function idSet(db: DB, name: string, ids: number[]): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error('bad temp table name');
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${name}(id INTEGER PRIMARY KEY); DELETE FROM temp.${name};`);
  db.prepare(`INSERT OR IGNORE INTO temp.${name}(id) SELECT value FROM json_each(?)`).run(JSON.stringify(ids));
  return `SELECT id FROM temp.${name}`;
}

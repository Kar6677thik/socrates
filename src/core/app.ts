import { randomBytes } from 'node:crypto';
import { type DB, openDb, now, getSetting, setSetting, backupIfDue, DEFAULT_DB_PATH } from './db.ts';
import { Tags } from './tags.ts';
import { Questions } from './questions.ts';
import { Study } from './study.ts';
import { Stats } from './stats.ts';

export type Undo =
  | { kind: 'archive_questions'; ids: number[] }
  | { kind: 'restore_version'; id: number; version: number }
  | { kind: 'delete_tags'; ids: number[] }
  | { kind: 'set_status'; items: { id: number; status: string }[] };

export interface Preset {
  name: string;
  config: Record<string, unknown>;
}

/** Everything the server and MCP layers need, wired to one database. */
export class App {
  db: DB;
  dbPath: string;
  tags: Tags;
  questions: Questions;
  study: Study;
  stats: Stats;

  constructor(path = DEFAULT_DB_PATH) {
    this.dbPath = path;
    this.db = openDb(path);
    this.tags = new Tags(this.db);
    this.questions = new Questions(this.db, this.tags);
    this.study = new Study(this.db, this.questions);
    this.stats = new Stats(this.db, this.tags);
    try { backupIfDue(this.db, path); } catch { /* another process may hold the file; next run will retry */ }
  }

  /** Bearer token for the HTTP MCP endpoint, created on first use. */
  mcpToken(): string {
    let t = getSetting<string | null>(this.db, 'mcp_token', null);
    if (!t) {
      t = randomBytes(24).toString('base64url');
      setSetting(this.db, 'mcp_token', t);
    }
    return t;
  }

  audit(actor: string, tool: string, args: unknown, result: unknown, undo: Undo | null) {
    const trim = (v: unknown) => {
      const s = JSON.stringify(v ?? null);
      return s.length > 20000 ? s.slice(0, 20000) + '…' : s;
    };
    this.db
      .prepare('INSERT INTO audit_log(at, actor, tool, args, result, undo) VALUES(?,?,?,?,?,?)')
      .run(now(), actor, tool, trim(args), trim(result), undo ? JSON.stringify(undo) : null);
  }

  auditLog(limit = 100) {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({
      ...r,
      args: safeJson(r.args),
      result: safeJson(r.result),
      undo: r.undo ? JSON.parse(r.undo) : null,
    }));
  }

  revert(auditId: number) {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(auditId) as any;
    if (!row) throw new Error('Audit entry not found.');
    if (row.reverted_at) throw new Error('Already reverted.');
    if (!row.undo) throw new Error('This action cannot be reverted.');
    const u = JSON.parse(row.undo) as Undo;
    let detail: unknown;
    switch (u.kind) {
      case 'archive_questions': detail = { archived: this.questions.setStatus(u.ids, 'archived') }; break;
      case 'restore_version': detail = this.questions.restore(u.id, u.version, 'user'); break;
      case 'delete_tags': detail = { deleted: [...u.ids].reverse().filter((id) => this.tags.deleteIfUnused(id)) }; break;
      case 'set_status': for (const it of u.items) this.questions.setStatus([it.id], it.status as any); detail = { restored: u.items.length }; break;
    }
    this.db.prepare('UPDATE audit_log SET reverted_at = ? WHERE id = ?').run(now(), auditId);
    return detail;
  }

  settings() {
    return {
      new_per_day: getSetting(this.db, 'new_per_day', 20),
      reviews_per_day: getSetting(this.db, 'reviews_per_day', 200),
      retention: getSetting(this.db, 'retention', 0.9),
      agent_drafts: getSetting(this.db, 'agent_drafts', true),
      leech_threshold: getSetting(this.db, 'leech_threshold', 6),
    };
  }

  /** Embed questions that have no vector yet, in the background. */
  async backfillEmbeddings() {
    try {
      while ((await this.questions.backfillEmbeddings()) > 0);
    } catch (e: any) {
      console.error('[socrates] embedding backfill failed:', e.message);
    }
  }

  presets(): Preset[] {
    return getSetting<Preset[]>(this.db, 'presets', []);
  }

  savePresets(list: Preset[]) {
    if (!Array.isArray(list) || list.length > 50) throw new Error('Invalid presets');
    for (const p of list) if (typeof p?.name !== 'string' || !p.name.trim() || typeof p.config !== 'object') throw new Error('Each preset needs a name and config');
    setSetting(this.db, 'presets', list.map((p) => ({ name: p.name.trim().slice(0, 60), config: p.config })));
    return this.presets();
  }

  updateSettings(patch: Record<string, unknown>) {
    const allowed: Record<string, (v: any) => boolean> = {
      new_per_day: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
      reviews_per_day: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
      retention: (v) => typeof v === 'number' && v >= 0.7 && v <= 0.99,
      agent_drafts: (v) => typeof v === 'boolean',
      leech_threshold: (v) => Number.isInteger(v) && v >= 2 && v <= 50,
    };
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed[k]) throw new Error(`Unknown setting ${k}`);
      if (!allowed[k](v)) throw new Error(`Invalid value for ${k}`);
      setSetting(this.db, k, v);
    }
    return this.settings();
  }
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CATEGORIES = new Set(['identity','preferences','goals','projects','decisions','workflows','other']);
const SENSITIVE = /(?:password|passcode|api[_ -]?key|secret|private[_ -]?key|ssn|sin number|credit card|card number|access token|refresh token|비밀번호|인증번호|카드번호|주민등록번호)/i;
const ATTACK = /(?:ignore (?:all |previous |earlier )?instructions|system prompt|developer message|override (?:your |the )?instructions|지시를 무시|시스템 프롬프트)/i;
const MAX_FACTS = 3000;

export function normalizeKey(key) {
  return String(key ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 120);
}
export function safeValue(value) {
  const s = String(value ?? '').trim();
  return s.length > 0 && s.length <= 600 && !SENSITIVE.test(s) && !ATTACK.test(s);
}
export function relevance(fact, query) {
  const terms = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])];
  const hay = `${fact.key} ${fact.value} ${fact.category}`.toLowerCase();
  let n = 0;
  for (const term of terms) if (hay.includes(term)) n++;
  return n * 10 + (fact.importance === 'high' ? 3 : 0) + fact.confidence * 2;
}

export class MemoryStore {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;`);
    if (filename !== ':memory:') this.db.exec(`PRAGMA journal_mode = WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, fact_key TEXT NOT NULL,
        value TEXT NOT NULL, importance TEXT NOT NULL DEFAULT 'normal',
        confidence REAL NOT NULL, updated_at TEXT NOT NULL,
        source_session TEXT NOT NULL, source_entry TEXT NOT NULL,
        UNIQUE(category,fact_key)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, source_session TEXT NOT NULL,
        source_entry TEXT NOT NULL, recorded_at TEXT NOT NULL,
        FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS fact_vectors (
        fact_id TEXT PRIMARY KEY, model TEXT NOT NULL, embedding TEXT NOT NULL,
        FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        category TEXT NOT NULL, fact_key TEXT NOT NULL,
        removed_at TEXT NOT NULL, PRIMARY KEY(category,fact_key)
      );
      CREATE TABLE IF NOT EXISTS seen_entries (
        session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(session_id,entry_id)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  isSeen(sessionId, entryId) {
    return !!this.db.prepare('SELECT 1 FROM seen_entries WHERE session_id=? AND entry_id=?').get(sessionId, entryId);
  }
  markSeen(entries) {
    const st = this.db.prepare('INSERT OR IGNORE INTO seen_entries VALUES(?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) st.run(e.sessionId, e.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  facts(limit=MAX_FACTS) {
    return this.db.prepare('SELECT id,category,fact_key AS key,value,importance,confidence,updated_at AS updatedAt,source_session AS sourceSession,source_entry AS sourceEntry FROM facts ORDER BY updated_at DESC LIMIT ?').all(limit);
  }
  count() { return this.db.prepare('SELECT count(*) AS n FROM facts').get().n; }

  /** A version/model change, fact edit, or forgotten memory invalidates the old vector. */
  pendingVectors(model, limit = 24) {
    return this.db.prepare(`SELECT f.id, f.category, f.fact_key AS key, f.value
      FROM facts f LEFT JOIN fact_vectors v ON v.fact_id=f.id
      WHERE v.fact_id IS NULL OR v.model<>?
      ORDER BY f.updated_at DESC LIMIT ?`).all(model, Math.max(1, Math.min(100, limit)));
  }
  saveVector(factId, expectedValue, model, vector) {
    if (!Array.isArray(vector) || !vector.length || vector.length > 8192 ||
        !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    // A concurrent update must not attach an outdated embedding to a newer fact.
    if (!this.db.prepare('SELECT 1 FROM facts WHERE id=? AND value=?').get(factId, expectedValue)) return false;
    this.db.prepare(`INSERT INTO fact_vectors(fact_id,model,embedding) VALUES(?,?,?)
      ON CONFLICT(fact_id) DO UPDATE SET model=excluded.model,embedding=excluded.embedding`)
      .run(factId, model, JSON.stringify(vector));
    return true;
  }
  semanticScores(vector, model) {
    const scores = new Map();
    if (!Array.isArray(vector) || !vector.length) return scores;
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) return scores;
    const rows = this.db.prepare('SELECT fact_id AS id,embedding FROM fact_vectors WHERE model=?').all(model);
    for (const row of rows) {
      let stored;
      try { stored = JSON.parse(row.embedding); } catch { continue; }
      if (!Array.isArray(stored) || stored.length !== vector.length) continue;
      let dot=0, len=0;
      for (let i=0;i<vector.length;i++) { dot+=vector[i]*stored[i];len+=stored[i]*stored[i]; }
      if (len > 0 && Number.isFinite(dot)) scores.set(row.id, dot/(norm*Math.sqrt(len)));
    }
    return scores;
  }
  sourceReferences(term, limit = 20) {
    const needle=String(term).trim().toLowerCase();
    const fact=this.facts().find((f) => f.key.toLowerCase()===needle ||
      (f.category+'/'+f.key).toLowerCase()===needle);
    if (!fact) return null;
    const evidence=this.db.prepare(`SELECT source_session AS sessionId,source_entry AS entryId,
      recorded_at AS recordedAt FROM evidence WHERE fact_id=? ORDER BY recorded_at DESC LIMIT ?`)
      .all(fact.id, Math.max(1, Math.min(limit, 50)));
    return {fact, evidence};
  }
  apply(operations, source, options={}) {
    const allowSensitive = options.allowSensitive === true;
    const recordedAt = new Date().toISOString();
    const result={upserted:0,forgotten:0,skipped:0};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of operations.slice(0,30)) {
        if (!op || !CATEGORIES.has(op.category)) {result.skipped++;continue;}
        const key=normalizeKey(op.key);
        if (!key || key.length < 2 || key.length > 120) {result.skipped++;continue;}
        if (op.action === 'forget') {
          this.db.prepare('DELETE FROM facts WHERE category=? AND fact_key=?').run(op.category,key);
          this.db.prepare('INSERT INTO tombstones(category,fact_key,removed_at) VALUES(?,?,?) ON CONFLICT(category,fact_key) DO UPDATE SET removed_at=excluded.removed_at').run(op.category,key,recordedAt);
          result.forgotten++;continue;
        }
        if (op.action !== 'upsert' || typeof op.value !== 'string' || !safeValue(op.value) || (op.sensitive === true && !allowSensitive)) {result.skipped++;continue;}
        // Unconfirmed, low-quality extraction is not durable memory.
        if (typeof op.confidence !== 'number' || !Number.isFinite(op.confidence) || op.confidence < 0.6 || op.confidence > 1) {result.skipped++;continue;}
        const tombstone=this.db.prepare('SELECT 1 FROM tombstones WHERE category=? AND fact_key=?').get(op.category,key);
        if (tombstone && op.restore !== true) {result.skipped++;continue;}
        if (tombstone) this.db.prepare('DELETE FROM tombstones WHERE category=? AND fact_key=?').run(op.category,key);
        const value=String(op.value).trim();
        const confidence=op.confidence;
        const importance=op.importance==='high'?'high':'normal';
        const existing=this.db.prepare('SELECT id FROM facts WHERE category=? AND fact_key=?').get(op.category,key);
        const id=existing?.id ?? randomUUID();
        this.db.prepare(`INSERT INTO facts(id,category,fact_key,value,importance,confidence,updated_at,source_session,source_entry)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(category,fact_key) DO UPDATE SET
          value=excluded.value, importance=excluded.importance, confidence=excluded.confidence,
          updated_at=excluded.updated_at, source_session=excluded.source_session,
          source_entry=excluded.source_entry`).run(id,op.category,key,value,importance,confidence,recordedAt,source.sessionId,source.entryId);
        this.db.prepare('DELETE FROM fact_vectors WHERE fact_id=?').run(id);
        this.db.prepare('INSERT INTO evidence(id,fact_id,source_session,source_entry,recorded_at) VALUES(?,?,?,?,?)').run(randomUUID(),id,source.sessionId,source.entryId,recordedAt);
        result.upserted++;
      }
      this.db.exec('COMMIT');
      return result;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  forget(term) {
    const query=String(term).trim().toLowerCase();
    if(!query) return 0;
    const found=this.facts().filter(f => f.key.toLowerCase()===query || `${f.category}/${f.key}`.toLowerCase()===query || f.value.toLowerCase().includes(query));
    if(!found.length) return 0;
    for(const f of found) this.apply([{action:'forget',category:f.category,key:f.key}],{sessionId:'manual',entryId:'command'});
    return found.length;
  }
  context(query='',maxChars=5000,vectorScores=null) {
    const all=this.facts();
    const byScore=all.map(f => ({f,score:relevance(f,query)+Math.max(0,vectorScores?.get(f.id) ?? 0)*12})).sort((a,b)=>b.score-a.score || b.f.updatedAt.localeCompare(a.f.updatedAt));
    // Keep a compact stable identity/preferences/goals profile, then topical context.
    const keys=new Set(); const chosen=[];
    const push=f=> {const k=`${f.category}/${f.key}`;if(!keys.has(k)){keys.add(k);chosen.push(f);}};
    for(const {f} of byScore.filter(({f})=>['identity','preferences','goals'].includes(f.category)).slice(0,20))push(f);
    for(const {f} of byScore.slice(0,45))push(f);
    let out='';
    for(const f of chosen) {
      const line=`- [${f.category}/${f.key}] ${f.value} (source: session=${JSON.stringify(f.sourceSession)}, entry=${JSON.stringify(f.sourceEntry)})\n`;
      if ((out+line).length>maxChars) continue;
      out+=line;
    }
    return out;
  }
  profile() {
    const result = [];
    for (const category of CATEGORIES) {
      const facts = this.facts().filter(f => f.category === category);
      if (facts.length) result.push(`## ${category}\n${facts.map(f => `- ${f.value}`).join('\n')}`);
    }
    return result.join('\n\n');
  }
  export() { return {format:'pi-user-memory/1',exportedAt:new Date().toISOString(),facts:this.facts()}; }
  clear() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const f of this.facts()) {
        this.db.prepare('INSERT OR REPLACE INTO tombstones(category,fact_key,removed_at) VALUES(?,?,?)').run(f.category,f.key,new Date().toISOString());
      }
      this.db.exec('DELETE FROM facts'); this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}

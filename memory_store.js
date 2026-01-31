'use strict';

const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

let _db = null;
let _dbPath = null;

function _assertInit() {
  if (!_db) throw new Error('memory_store not initialized. Call init(dbPath) first.');
}

function init(dbPath) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite not available in this runtime (Electron Node version mismatch?).');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('init(dbPath): dbPath required');
  }

  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;

  // Pragmas (safe defaults)
  _db.exec('PRAGMA journal_mode=WAL;');
  _db.exec('PRAGMA synchronous=NORMAL;');
  _db.exec('PRAGMA temp_store=MEMORY;');
  _db.exec('PRAGMA busy_timeout=5000;');

  // Minimal meta table (future-proof)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS meta(
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  // FTS5 store (index only "text"; everything else UNINDEXED but stored)
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text,
      role UNINDEXED,
      run_id UNINDEXED,
      proof_json_path UNINDEXED,
      ts UNINDEXED,
      meta_json UNINDEXED,
      tokenize='unicode61'
    );
  `);

  const up = _db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)');
  up.run('schema_version', '1');

  return true;
}

function _safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function addItem({ runId, role, content, proofJsonPath, meta }) {
  _assertInit();

  const text = (content == null) ? '' : String(content);
  if (!text.trim()) return false;

  const ts = new Date().toISOString();
  const metaJson = meta ? JSON.stringify(meta) : null;

  const stmt = _db.prepare(`
    INSERT INTO memory_fts(text, role, run_id, proof_json_path, ts, meta_json)
    VALUES(?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    text,
    role ? String(role) : '',
    runId ? String(runId) : '',
    proofJsonPath ? String(proofJsonPath) : '',
    ts,
    metaJson
  );

  return true;
}

function _ftsQueryFromText(q) {
  if (!q || typeof q !== 'string') return null;

  // keep letters/numbers/underscore + spaces
  const cleaned = q
    .trim()
    .replace(/[^\p{L}\p{N}_ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const tokens = cleaned.split(' ').filter(Boolean).slice(0, 12);
  if (tokens.length === 0) return null;

  // prefix search AND-joined
  // Grammar: term := phrase [*]  => "token"* is valid
  return tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

function search(query, limit = 8) {
  _assertInit();

  const ftsq = _ftsQueryFromText(query);
  if (!ftsq) return [];

  const lim = Math.max(1, Math.min(50, Number(limit) || 8));

  // In FTS5, bm25() lower is better
  const stmt = _db.prepare(`
    SELECT
      rowid,
      text,
      role,
      run_id,
      proof_json_path,
      ts,
      meta_json,
      bm25(memory_fts) AS rank
    FROM memory_fts
    WHERE memory_fts MATCH ?
    ORDER BY rank ASC
    LIMIT ?
  `);

  const rows = stmt.all(ftsq, lim) || [];
  return rows.map(r => ({
    id: r.rowid,
    text: r.text,
    role: r.role,
    runId: r.run_id,
    proofJsonPath: r.proof_json_path,
    ts: r.ts,
    meta: r.meta_json ? _safeParse(r.meta_json) : null,
    rank: r.rank
  }));
}

function _truncate(s, n) {
  const str = (s == null) ? '' : String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 3)) + '...';
}

function buildContext(taskText, opts = {}) {
  _assertInit();

  const limitRuns = Math.max(1, Math.min(10, Number(opts.limitRuns ?? 5)));
  const maxChars = Math.max(500, Math.min(20000, Number(opts.maxChars ?? 4500)));
  const perRunMsgs = Math.max(2, Math.min(10, Number(opts.perRunMsgs ?? 6)));

  const hits = search(taskText, 20);
  if (!hits.length) return '';

  // Pick distinct run_ids in hit order
  const runIds = [];
  const seen = new Set();
  for (const h of hits) {
    const rid = (h.runId || '').trim();
    if (!rid) continue;
    if (seen.has(rid)) continue;
    seen.add(rid);
    runIds.push(rid);
    if (runIds.length >= limitRuns) break;
  }

  let out = 'MEMORY_CONTEXT (local recall)\n';

  // If no run_id available, fallback to top hits lines
  if (!runIds.length) {
    out += '\n[top hits]\n';
    for (const h of hits.slice(0, limitRuns)) {
      out += `- ${h.role || 'unknown'} @ ${h.ts || ''}: ${_truncate((h.text || '').replace(/\s+/g, ' ').trim(), 800)}\n`;
      if (h.proofJsonPath) out += `  proof: ${h.proofJsonPath}\n`;
      if (out.length >= maxChars) break;
    }
    return out.slice(0, maxChars);
  }

  const stmtMsgs = _db.prepare(`
    SELECT rowid, text, role, run_id, proof_json_path, ts
    FROM memory_fts
    WHERE run_id = ?
    ORDER BY ts ASC
    LIMIT ?
  `);

  for (const rid of runIds) {
    const msgs = stmtMsgs.all(rid, perRunMsgs) || [];
    if (!msgs.length) continue;

    out += `\n[run_id=${rid}]\n`;
    for (const m of msgs) {
      const role = (m.role || 'unknown').trim();
      const ts = (m.ts || '').trim();
      const text = _truncate((m.text || '').replace(/\s+/g, ' ').trim(), 1200);
      out += `- ${role} @ ${ts}: ${text}\n`;
      if (m.proof_json_path) out += `  proof: ${m.proof_json_path}\n`;
      if (out.length >= maxChars) break;
    }
    if (out.length >= maxChars) break;
  }

  return out.slice(0, maxChars);
}

function close() {
  if (_db) {
    try { _db.close(); } catch (_) {}
  }
  _db = null;
  _dbPath = null;
}

function getDbPath() {
  return _dbPath;
}

module.exports = {
  init,
  addItem,
  search,
  buildContext,
  close,
  getDbPath
};

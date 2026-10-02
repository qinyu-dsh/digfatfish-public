// One-time projection cache seq normalization (safe: cache is a rebuildable shortcut).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const home = process.env.USERPROFILE || 'C:\\Users\\<user>';
const cachePath = path.join(home, '.dsh', 'storages', 'session_projcache.json');
const dbPath = path.join(home, '.dsh', 'sessions', 'sessions.sqlite');

if (!fs.existsSync(cachePath)) { console.log('cache missing: nothing to normalize'); process.exit(0); }
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
const sessions = cache?.tables?.sessions || {};
let normalized = 0, legacy = 0, fail = 0;
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  for (const [sid, rec] of Object.entries(sessions)) {
    const row = db.prepare('SELECT f_head_sequence FROM t_sessions WHERE f_session_id=?').get(sid);
    if (!row) { legacy++; continue; }
    const h = row.f_head_sequence;
    if (!Number.isInteger(h) || h < 0) { fail++; continue; }
    for (const k of Object.keys(rec.rows || {})) rec.rows[k].seq = h;
    normalized++;
  }
} finally { db.close(); }
const tmp = cachePath + '.tmp-fix';
fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, cachePath);
console.log('normalized=' + normalized + ' legacy=' + legacy + ' fail=' + fail + ' path=' + cachePath);

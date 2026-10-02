// doctor-on-duty.cjs - purge GHOST session entries (deleted from sessions.sqlite) out of
// rebuildable projection caches. Safe: caches are shortcuts, backups are written first.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const home = process.env.USERPROFILE || 'C:\\Users\\<user>';
const dbPath = path.join(home, '.dsh', 'sessions', 'sessions.sqlite');
const targets = [
  { label: 'projcache', file: path.join(home, '.dsh', 'storages', 'session_projcache.json') },
  { label: 'feedback', file: path.join(home, '.dsh', 'storages', 'message_feedback.json') }
];
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const report = { at: new Date().toISOString(), live: 0, caches: [] };

const db = new DatabaseSync(dbPath, { readOnly: true });
let live = new Set();
try { live = new Set(db.prepare('SELECT f_session_id FROM t_sessions').all().map(r => r.f_session_id)); }
finally { db.close(); }
report.live = live.size;

for (const t of targets) {
  const r = { label: t.label, file: t.file, exists: fs.existsSync(t.file) };
  try {
    if (r.exists) {
      const cache = JSON.parse(fs.readFileSync(t.file, 'utf8'));
      const table = (cache && cache.tables && cache.tables.sessions) || {};
      const ids = Object.keys(table);
      const ghosts = ids.filter(id => !live.has(id));
      r.total = ids.length;
      r.ghosts = ghosts.length;
      r.ghostIds = ghosts;
      if (ghosts.length > 0) {
        const bak = t.file + '.bak-doctor-' + stamp;
        fs.copyFileSync(t.file, bak);
        r.backup = bak;
        for (const id of ghosts) delete table[id];
        const tmp = t.file + '.tmp-doctor';
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, t.file);
        r.removed = ghosts.length;
      }
    }
  } catch (e) { r.error = String((e && e.message) || e); }
  report.caches.push(r);
}
fs.writeFileSync(path.join(__dirname, 'doctor-on-duty.report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.caches.map(c => ({ label: c.label, total: c.total, ghosts: c.ghosts, removed: c.removed, backup: c.backup ? true : false, error: c.error }))));

// doctor-purge-sessions.cjs - hard-delete the listed sessions from sessions.sqlite
// Current target list (2026-09-16): the two "Ungrouped" ghosts whose cwd D:\豆包\doubao02
// no longer exists. They only live in the RDB now (no jsonl dir), so the GUI's
// archive-manager "physical delete" cannot remove them - see DSH调试经验.md 第二十五节.
//   - session-0145897b... title「你好」doubao test session, 15 events, 2026-09-15 17:32
//   - session-058e6352... blank session, 4 events, 2026-09-15 17:44
// History: first used 2026-09-13 to purge 13 sessions (11 picked + 2 children).
// Backup first: sessions.sqlite(+wal+shm) -> *.bak-doctor-<stamp>
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const home = process.env.USERPROFILE || 'C:\\Users\\<user>';
const dbPath = path.join(home, '.dsh', 'sessions', 'sessions.sqlite');
const ids = [
  // 2026-09-16 targets: the two Ungrouped ghosts from D:\豆包\doubao02
  "session-0145897b-a8e9-4dcd-974d-8a5a6392a23e",
  "session-058e6352-0cca-4e08-833a-685c7e5580bc"
  // 2026-09-13 batch (already purged, kept for reference):
  // "session-7530b34e-be8a-48cb-b48c-384fed4d2d70",
  // "session-214da06d-caa9-4afb-9c8b-15959aefc2c9",
  // "session-6356c28c-24c7-4efd-8c26-a39d0046491a",
  // "session-c8b5091d-6fc0-4527-808f-e561ed7cb9e4",
  // "session-fd6df13d-d330-4358-b666-c6255b259d2c",
  // "session-6f9d91da-c4d5-4e80-a5a6-008409c545c6",
  // "session-be30cd51-45db-472e-aab1-a5edc5304838",
  // "session-c0727760-3519-4b74-9e55-d59790874954",
  // "session-3786753b-2470-43ed-b388-6d6fbb5aed2b",
  // "session-08a76366-49da-4a03-b375-188950418ea4",
  // "session-9d05196a-fb1e-46be-9fa7-323e1dbc3baf",
  // "fbb7e4df-54c0-4739-ace3-55ed57d742fa",
  // "b6372e8c-d5e7-4176-9067-e75b9eaf76b8"
];
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const report = { at: new Date().toISOString(), requested: ids.length, backups: [], deleted: {}, remaining: null };

for (const ext of ['', '-wal', '-shm']) {
  const p = dbPath + ext;
  if (fs.existsSync(p)) { const b = p + '.bak-doctor-' + stamp; fs.copyFileSync(p, b); report.backups.push(path.basename(b)); }
}

const db = new DatabaseSync(dbPath);
const ph = ids.map(function () { return '?'; }).join(',');
try {
  db.exec('BEGIN IMMEDIATE');
  const evRows = db.prepare('SELECT COUNT(*) AS n FROM t_events WHERE f_event_id IN (SELECT f_event_id FROM t_session_events WHERE f_session_id IN (' + ph + '))').get(...ids);
  db.prepare('DELETE FROM t_events WHERE f_event_id IN (SELECT f_event_id FROM t_session_events WHERE f_session_id IN (' + ph + '))').run(...ids);
  const seRes = db.prepare('DELETE FROM t_session_events WHERE f_session_id IN (' + ph + ')').run(...ids);
  const sRes = db.prepare('DELETE FROM t_sessions WHERE f_session_id IN (' + ph + ')').run(...ids);
  db.exec('COMMIT');
  report.deleted = { events: evRows ? evRows.n : null, sessionEvents: seRes && seRes.changes, sessions: sRes && sRes.changes };
  report.remaining = db.prepare('SELECT COUNT(*) AS n FROM t_sessions').get().n;
  try { db.exec('VACUUM'); report.vacuumed = true; } catch (e) { report.vacuumError = String((e && e.message) || e); }
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (e2) { }
  report.error = String((e && e.message) || e);
} finally { db.close(); }

fs.writeFileSync(path.join(__dirname, 'doctor-purge.report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report));

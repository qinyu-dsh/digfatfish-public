#!/usr/bin/env node
/**
 * session-db-prefix.mjs — bring an old (v1) session DB to the v2 baseline shape that
 * @morlay/session-rdb >= 0.0.20 expects, then let the package run its own v3 migrations.
 *
 * v2 (2026-09-21) rewrites instead of patching columns. The first attempt only ADDED the
 * columns the new code wants and left the legacy ones in place; t_events.f_original_seq was
 * NOT NULL there, while the new code's INSERT does not mention that column at all, so every
 * message send died with "NOT NULL constraint failed: t_events.f_original_seq". The table is
 * now rebuilt to the exact v2 DDL (legacy columns dropped, data mapped over), which is the
 * only shape the new inserts, the v3 migrations and the runtime queries all agree on.
 *
 * Usage: node session-db-prefix.mjs [--db <path>] [--apply] [--probe]
 *   default db = %DSH_HOME%/sessions/sessions.sqlite  (DSH_HOME or %USERPROFILE%/.dsh)
 *   --probe    after prefixing, run the new code's exact INSERT shape as a smoke test
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PROBE = argv.includes('--probe');
const dbArg = argv.indexOf('--db');
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || 'C:\\Users\\<user>', '.dsh');
const dbPath = dbArg >= 0 ? argv[dbArg + 1] : path.join(home, 'sessions', 'sessions.sqlite');

const T_EVENTS_V2 = `CREATE TABLE "t_events_v2" (
  "f_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "f_event_id" TEXT NOT NULL UNIQUE,
  "f_parent_id" TEXT NOT NULL DEFAULT '',
  "f_type" TEXT NOT NULL DEFAULT '',
  "f_kind" TEXT NOT NULL DEFAULT '',
  "f_role" TEXT NOT NULL DEFAULT '',
  "f_name" TEXT NOT NULL DEFAULT '',
  "f_action_id" TEXT NOT NULL DEFAULT '',
  "f_encoding" TEXT NOT NULL DEFAULT '',
  "f_data" TEXT NOT NULL,
  "f_created_at" INTEGER NOT NULL DEFAULT 0
)`;
const T_SESSION_EVENTS_V2 = `CREATE TABLE "t_session_events_v2" (
  "f_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "f_session_id" TEXT NOT NULL REFERENCES "t_sessions"("f_session_id") ON DELETE CASCADE,
  "f_event_id" TEXT NOT NULL REFERENCES "t_events"("f_event_id") ON DELETE CASCADE,
  "f_sequence" INTEGER NOT NULL,
  "f_surface_op" TEXT,
  "f_original_seq" INTEGER NOT NULL DEFAULT 0,
  UNIQUE ("f_session_id", "f_sequence")
)`;

const report = { at: new Date().toISOString(), db: dbPath, mode: APPLY ? 'APPLY' : 'DRY-RUN', steps: [], before: {}, after: {}, probe: null };
if (!fs.existsSync(dbPath)) { console.log(JSON.stringify({ ...report, error: 'db not found' }, null, 1)); process.exit(1); }
const db = new DatabaseSync(dbPath);
const uv = () => db.prepare('PRAGMA user_version').get().user_version;
const count = (t) => { try { return db.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch { return -1; } };
const col = (t, c) => db.prepare('SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?').get(t, c).c;
report.before = { user_version: uv(), events: count('t_events'), sessionEvents: count('t_session_events'), legacyOriginalSeqNotNull: db.prepare("SELECT [notnull] n FROM pragma_table_info('t_events') WHERE name='f_original_seq'").get()?.n ?? null };

if (uv() === 1) {
  db.exec('PRAGMA foreign_keys = OFF');           // SQLite's documented table-rebuild procedure
  db.exec('BEGIN IMMEDIATE');
  try {
    if (col('t_session_events', 'f_original_seq') === 0 || col('t_session_events', 'f_surface_op') === 0) {
      db.exec(T_SESSION_EVENTS_V2);
      const picked = [
        'f_id', 'f_session_id', 'f_event_id', 'f_sequence',
        col('t_session_events', 'f_surface_op') ? 'f_surface_op' : 'NULL',
        col('t_session_events', 'f_original_seq') ? 'f_original_seq' : 'COALESCE((SELECT e.f_original_seq FROM t_events e WHERE e.f_event_id = t_session_events.f_event_id), 0)'
      ].join(', ');
      db.exec('INSERT INTO t_session_events_v2 (f_id, f_session_id, f_event_id, f_sequence, f_surface_op, f_original_seq) SELECT ' + picked + ' FROM t_session_events');
      db.exec('DROP TABLE t_session_events');
      db.exec('ALTER TABLE t_session_events_v2 RENAME TO t_session_events');
      report.steps.push({ label: 't_session_events rebuilt to v2 (f_surface_op + f_original_seq present)', sessionEvents: count('t_session_events') });
    } else { report.steps.push({ label: 't_session_events already v2 (skip)', sessionEvents: count('t_session_events') }); }

    if (col('t_events', 'f_type') === 0) {
      db.exec(T_EVENTS_V2);
      db.exec(`INSERT INTO t_events_v2 (f_id, f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding, f_data, f_created_at)
               SELECT f_id, f_event_id, f_parent_id, COALESCE(f_kind, ''), f_kind, f_role, f_name, f_action_id, f_encoding, f_data, f_created_at FROM t_events`);
      db.exec('DROP TABLE t_events');
      db.exec('ALTER TABLE t_events_v2 RENAME TO t_events');
      report.steps.push({ label: 't_events rebuilt to v2 (legacy f_original_seq / f_source_event_seqs / f_surface_op dropped)', events: count('t_events') });
    } else { report.steps.push({ label: 't_events already v2 (skip)', events: count('t_events') }); }

    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    report.steps.push({ label: 'stamp user_version = 2', ok: true });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { }
    report.steps.push({ label: 'FAILED', error: String(error.message || error) });
    db.exec('PRAGMA foreign_keys = ON');
    console.log(JSON.stringify(report, null, 1));
    process.exit(1);
  }
  db.exec('PRAGMA foreign_keys = ON');
} else {
  report.steps.push({ label: 'skip: user_version=' + uv() });
}
report.after = { user_version: uv(), events: count('t_events'), sessionEvents: count('t_session_events'), integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
if (PROBE) {
  // the exact insert shape the new code uses: no f_original_seq, no f_source_event_seqs
  try {
    db.prepare("INSERT INTO t_events (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding, f_data, f_created_at) VALUES (?, '', '', 'probe/noop', '', '', '', '', '{}', 0)").run('probe-' + Date.now());
    db.prepare('DELETE FROM t_events WHERE f_kind = ?').run('probe/noop');
    report.probe = 'OK - new-style INSERT accepted';
  } catch (error) { report.probe = 'FAILED - ' + String(error.message || error); }
}
db.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.probe && report.probe.startsWith('FAILED') ? 1 : 0);

#!/usr/bin/env node
/**
 * restore-sessions.cjs —— 把丢失的会话整段搬回「当前权威库」
 *
 * 背景（见 DSH调试经验.md 第二十七/二十八节）：核心降级回 0.1.1-rc.2 时，新版 schema 的
 * sessions.sqlite 被改名为 sessions-from-new-core-*.sqlite，旧核新建了一个空库 → 老会话
 * 在 GUI 里消失。本脚本把指定会话从源库整段（会话行 + 全量事件 + 会话-事件映射）搬回去。
 *
 * 用法:
 *   node restore-sessions.cjs --from <源库> --to <目标库> --ids id1,id2 [--dry-run]
 *   node restore-sessions.cjs --from <源库> --to <目标库> --all [--dry-run]
 *
 * 要点:
 *   - 源库比目标库多出的新列会被丢弃（已实测：目标库需要的列源库全都有，零丢失）:
 *       t_sessions: f_archived_at / f_title / f_title_seq
 *       t_events:   f_type
 *       t_session_events: f_surface_op
 *   - 单事务写入；目标库已存在同 id 会话则跳过（幂等，可重复跑）
 *   - 跑完自校验: 每会话事件数 / 序列连续性 / PRAGMA integrity_check
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const from = arg('from');
const to = arg('to');
const dryRun = has('dry-run');
const all = has('all');
let ids = (arg('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);

if (!from || !to) { console.error('用法: node restore-sessions.cjs --from <源库> --to <目标库> (--ids a,b | --all) [--dry-run]'); process.exit(2); }
if (!fs.existsSync(from)) { console.error('源库不存在: ' + from); process.exit(2); }
if (!fs.existsSync(to)) { console.error('目标库不存在: ' + to); process.exit(2); }

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const SESS_COLS = ['f_session_id','f_head_event_id','f_head_sequence','f_version','f_created_at','f_cwd','f_parent_session','f_seed_length','f_origin','f_delegation_depth','f_incarnation','f_revision'];
const EV_COLS = ['f_event_id','f_parent_id','f_kind','f_role','f_name','f_action_id','f_encoding','f_data','f_created_at','f_original_seq','f_source_event_seqs','f_surface_op'];
const SE_COLS = ['f_session_id','f_event_id','f_sequence'];

const src = new DatabaseSync(from, { readOnly: true });
const dst = new DatabaseSync(to);
const report = { from, to, dryRun, at: new Date().toISOString(), sessions: [], skipped: [], checks: {} };

try {
  src.exec('PRAGMA query_only = ON');
  const srcCols = (t) => src.prepare('pragma table_info(' + t + ')').all().map(r => r.name);
  const dstCols = (t) => dst.prepare('pragma table_info(' + t + ')').all().map(r => r.name);
  const missing = [];
  for (const [t, cols] of [['t_sessions', SESS_COLS], ['t_events', EV_COLS], ['t_session_events', SE_COLS]]) {
    const have = dstCols(t);
    for (const c of cols) if (!have.includes(c)) missing.push(t + '.' + c);
  }
  if (missing.length) { console.error('目标库缺少必要列: ' + missing.join(', ')); process.exit(3); }

  if (all) ids = src.prepare('select f_session_id from t_sessions order by f_id').all().map(r => r.f_session_id);
  if (!ids.length) { console.error('没有指定会话 id'); process.exit(2); }

  dst.exec('ATTACH DATABASE ' + q(from) + ' AS src');

  const existsStmt = dst.prepare('select 1 from t_sessions where f_session_id = ?');
  const evCount = dst.prepare('select count(*) c from t_session_events where f_session_id = ?');

  dst.exec('BEGIN IMMEDIATE');
  for (const sid of ids) {
    if (existsStmt.get(sid)) { report.skipped.push(sid); continue; }
    const before = evCount.get(sid).c;
    dst.prepare('INSERT INTO t_sessions (' + SESS_COLS.join(',') + ') SELECT ' + SESS_COLS.join(',') + ' FROM src.t_sessions WHERE f_session_id = ?').run(sid);
    dst.prepare('INSERT INTO t_events (' + EV_COLS.join(',') + ') SELECT ' + EV_COLS.map(c => 'e.' + c).join(',') +
      ' FROM src.t_events e JOIN src.t_session_events se ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ?').run(sid);
    dst.prepare('INSERT INTO t_session_events (' + SE_COLS.join(',') + ') SELECT ' + SE_COLS.join(',') + ' FROM src.t_session_events WHERE f_session_id = ?').run(sid);
    const after = evCount.get(sid).c;
    report.sessions.push({ id: sid, eventsBefore: before, eventsAfter: after, inserted: after - before });
  }
  const chk = (sid) => {
    const s = dst.prepare('select f_head_sequence, f_head_event_id, f_created_at, f_cwd from t_sessions where f_session_id = ?').get(sid);
    const e = dst.prepare('select count(*) n, min(f_sequence) mn, max(f_sequence) mx, count(distinct f_sequence) d from t_session_events where f_session_id = ?').get(sid);
    const head = dst.prepare('select e.f_event_id as eid from t_events e join t_session_events se on se.f_event_id = e.f_event_id where se.f_session_id = ? order by se.f_sequence desc limit 1').get(sid);
    return { id: sid, head_sequence: s && s.f_head_sequence, events: e.n, seq: e.mn + '~' + e.mx, distinct: e.d, head_id_matches: !!(head && s && head.eid === s.f_head_event_id), cwd: s && s.f_cwd };
  };
  report.checks.perSession = ids.filter(id => !report.skipped.includes(id)).map(chk);
  report.checks.integrity = dst.prepare('PRAGMA integrity_check').get();
  report.checks.totalSessions = dst.prepare('select count(*) c from t_sessions').get().c;
  report.checks.totalEvents = dst.prepare('select count(*) c from t_events').get().c;

  // 校验跑完（在同一事务内可见）再决定提交还是回滚
  if (dryRun) dst.exec('ROLLBACK'); else dst.exec('COMMIT');
  dst.exec('DETACH DATABASE src');
} catch (err) {
  try { dst.exec('ROLLBACK'); } catch {}
  report.error = String(err && err.message || err);
  console.error(JSON.stringify(report, null, 1));
  process.exit(1);
} finally {
  try { src.close(); } catch {}
  try { dst.close(); } catch {}
}
console.log(JSON.stringify(report, null, 1));
if (report.error) process.exit(1);

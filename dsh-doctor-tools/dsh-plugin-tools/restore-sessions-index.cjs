#!/usr/bin/env node
/**
 * restore-sessions-index.cjs —— 把恢复回来的会话登记进侧栏索引
 *
 * 为什么需要它：会话的"归档"状态在当前栈里只存在 storages/workspace.json 的
 * global.archivedSessionIds；而侧栏分组读的是 workspaces[<id>].sessionIds。
 * 库里的行恢复了、索引没登记的话，会话会掉进「未分组」。
 *
 * 用法: node restore-sessions-index.cjs --ids id1,id2 [--file <workspace.json>] [--db <sessions.sqlite>]
 * 规则:
 *   - 已在 archivedSessionIds 里的 id 不动（保持归档，不塞进工作区）
 *   - 其余 id 按会话 cwd 匹配工作区 path 后追加到 sessionIds
 *   - 写盘前备份 *.bak-restore-<时间戳>
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ids = (arg('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const file = arg('file', path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'));
const dbFile = arg('db', path.join(os.homedir(), '.dsh', 'sessions', 'sessions.sqlite'));
if (!ids.length) { console.error('需要 --ids'); process.exit(2); }

const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const ws = JSON.parse(raw);
const archived = new Set((ws.global && ws.global.archivedSessionIds) || []);
const workspaces = (ws.tables && ws.tables.workspaces) || {};

// 会话 cwd：优先查库（权威），查不到就跳过分组
const cwdOf = {};
try {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  for (const id of ids) {
    const r = db.prepare('select f_cwd from t_sessions where f_session_id = ?').get(id);
    if (r && r.f_cwd) cwdOf[id] = r.f_cwd;
  }
  db.close();
} catch (e) { console.error('读库失败（跳过 cwd 匹配）: ' + e.message); }

const report = { file, added: [], skippedArchived: [], noWorkspaceMatch: [] };
for (const id of ids) {
  if (archived.has(id)) { report.skippedArchived.push(id); continue; }
  const cwd = cwdOf[id];
  const hit = Object.entries(workspaces).find(([, w]) => w && w.path && cwd && w.path.toLowerCase() === cwd.toLowerCase());
  if (!hit) { report.noWorkspaceMatch.push({ id, cwd: cwd || null }); continue; }
  const [wid, w] = hit;
  if (!Array.isArray(w.sessionIds)) w.sessionIds = [];
  if (!w.sessionIds.includes(id)) { w.sessionIds.push(id); w.updatedAt = new Date().toISOString(); report.added.push({ id, workspace: wid, path: w.path }); }
}
if (report.added.length) {
  const bak = file + '.bak-restore-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(ws, null, 2), 'utf8');
  report.backup = bak;
}
console.log(JSON.stringify(report, null, 1));

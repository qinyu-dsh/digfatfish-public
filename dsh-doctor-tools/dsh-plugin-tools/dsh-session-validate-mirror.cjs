const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(process.env.USERPROFILE,'.dsh','sessions','sessions.sqlite'), { readOnly: true });
const MSG_ROLE = { 'system/message':'system', 'user/message':'user', 'assistant/message':'assistant', 'tool/result':'user' };
const ELIGIBLE = new Set(['system/message','user/message','assistant/message','tool/result']);
const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function check(ev) {
  const errs = [];
  const t = ev.type, d = ev.data;
  if (!isRec(d)) { errs.push('data must be an object'); return errs; }
  if (t === 'request/header') {
    if (!isRec(d.header)) errs.push('header must be an object');
    else { if (Object.hasOwn(d.header,'system')) errs.push('header must omit system'); if (Array.isArray(d.header.tools) && d.header.tools.length===0) errs.push('must omit empty tools'); const ad=d.header.adapterDefaults; if (isRec(ad) && Object.keys(ad).length===0) errs.push('must omit empty adapterDefaults'); }
  }
  if (t === 'tool/result' && d.error !== undefined) { const b = isRec(d.message) && Array.isArray(d.message.content) ? d.message.content[0] : undefined; if (!isRec(b) || b.isError !== true) errs.push('error requires content[0].isError===true'); }
  if (t === 'assistant/attempt') { const turn=d.turn, step=d.step; if (typeof turn!=='number'||!Number.isSafeInteger(turn)||turn<0||typeof step!=='number'||!Number.isSafeInteger(step)||step<0||!Array.isArray(d.stream)) errs.push('invalid settlement fields'); }
  if (MSG_ROLE[t] !== undefined) {
    const message = t === 'user/message' ? d : d.message;
    if (!isRec(message) || typeof message.id !== 'string' || message.id === '') { errs.push('lacks an identified message'); return errs; }
    if (message.role !== MSG_ROLE[t]) errs.push('message must have role ' + MSG_ROLE[t] + ' (got ' + String(message.role) + ')');
    const s = message.source;
    if (!isRec(s) || typeof s.kind !== 'string' || s.kind === '') errs.push('message has invalid source');
    else if (t === 'system/message') { if (s.kind !== 'plugin' || typeof s.plugin !== 'string' || s.plugin === '') errs.push('system message must have plugin source'); }
    else if (t === 'assistant/message') { if (s.kind !== 'model' || typeof s.provider !== 'string' || !s.provider || typeof s.model !== 'string' || !s.model) errs.push('assistant message must have model source'); }
    else if (t === 'tool/result') { if (s.kind !== 'tool' || typeof s.callId !== 'string' || s.callId === '') errs.push('tool message must have tool source'); else { const c = message.content; const b = Array.isArray(c) ? c[0] : undefined; if (!Array.isArray(c) || c.length !== 1 || !isRec(b) || b.type !== 'tool-result' || !Array.isArray(b.content)) errs.push('must contain one tool-result block'); else if (b.toolCallId !== s.callId) errs.push('mismatched tool call ids'); } }
    if (!Array.isArray(message.content)) errs.push('message has invalid content');
  }
  if (ELIGIBLE.has(t) && ev.surfaceOp === undefined) errs.push('WARN eligible event without surfaceOp marker');
  if (!ELIGIBLE.has(t) && ev.surfaceOp !== undefined) errs.push('non-eligible carries surfaceOp');
  const op = ev.surfaceOp;
  if (op !== undefined && op !== 'append') { const keys = isRec(op) ? Object.keys(op) : []; if (!isRec(op) || keys.length !== 3 || op.op !== 'replace' || typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number' || op.startSeq >= ev.seq || op.endSeq >= ev.seq) errs.push('invalid replace surfaceOp'); }
  return errs;
}
for (const sid of ['session-ee5c847b-71fa-4e45-9dbe-a3ad73193fb8','session-bb72ddf0-77ff-420d-8217-bca0eb62f01b','session-4486b4c4-a90d-4c36-b61a-e3b69e85b036']) {
  const rows = db.prepare('SELECT se.f_sequence seq, se.f_surface_op so, e.f_type t, e.f_data d FROM t_session_events se JOIN t_events e ON e.f_event_id=se.f_event_id WHERE se.f_session_id=? ORDER BY se.f_sequence').all(sid);
  const bad = [], warn = [];
  for (const r of rows) {
    let data = null; try { data = JSON.parse(r.d); } catch (e) { bad.push({ seq: r.seq, err: 'data is not JSON' }); continue; }
    let op; if (r.so !== null) { try { op = JSON.parse(r.so); } catch (e) { op = undefined; } }
    const errs = check({ seq: r.seq, seqNum: r.seq, type: r.t, data: data.data !== undefined ? data.data : data, surfaceOp: op });
    const hard = errs.filter(e => !e.startsWith('WARN'));
    if (hard.length) bad.push({ seq: r.seq, type: r.t, err: hard.join('; ') });
    if (errs.length !== hard.length) warn.push({ seq: r.seq, type: r.t });
  }
  console.log('== ' + sid.slice(0, 23) + ' events=' + rows.length + ' hardErrors=' + bad.length + ' markerWarnings=' + warn.length);
  for (const b of bad.slice(0, 8)) console.log('   ERR #' + b.seq + ' [' + b.type + '] ' + b.err);
  const byType = {}; for (const w of warn) byType[w.type] = (byType[w.type] || 0) + 1;
  if (Object.keys(byType).length) console.log('   markerWarn:', JSON.stringify(byType));
}
db.close();
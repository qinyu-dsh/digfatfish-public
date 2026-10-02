const path=require('path'); const {DatabaseSync}=require('node:sqlite'); const fs=require('fs');
const S=path.join(process.env.USERPROFILE,'.dsh','sessions');
const db=new DatabaseSync(path.join(S,'sessions.sqlite'),{readOnly:true});
console.log('integrity:', db.prepare('PRAGMA integrity_check').get().integrity_check, '| sessions:', db.prepare('SELECT COUNT(*) n FROM t_sessions').get().n, '| orphans:', db.prepare('SELECT COUNT(*) n FROM t_events e WHERE NOT EXISTS (SELECT 1 FROM t_session_events se WHERE se.f_event_id=e.f_event_id)').get().n);
for (const s of db.prepare('SELECT f_session_id,f_title,f_head_sequence FROM t_sessions').all()) { const n=db.prepare('SELECT COUNT(*) n FROM t_session_events WHERE f_session_id=?').get(s.f_session_id).n; console.log('  '+s.f_title+'  rows='+n+' head='+s.f_head_sequence); }
db.close();
console.log('sessions dir:', fs.readdirSync(S).join(', '));
console.log('storages dir:', fs.readdirSync(path.join(process.env.USERPROFILE,'.dsh','storages')).join(', '));
const t=fs.readFileSync('D:/dhs01/DSH调试经验.md','utf8');
console.log('notes:', t.split(String.fromCharCode(10)).length-1, 'lines /', (t.match(/^## /gm)||[]).length, 'sections');
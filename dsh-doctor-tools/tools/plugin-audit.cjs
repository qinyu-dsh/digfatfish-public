const fs=require('fs'); const path=require('path');
const root = path.join(process.env.USERPROFILE,'.dsh','profiles','web','node_modules');
const seen = new Map();
function readPkg(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')); } catch(e) { return null; } }
function scan(scope, name) {
  const dir = scope ? path.join(root, scope, name) : path.join(root, name);
  const p = readPkg(dir); if (!p) return;
  const isDshPlugin = !!(p.dsh || /dsh/i.test(p.name));
  if (isDshPlugin) seen.set(p.name, { version: p.version, engines: (p.dsh&&p.dsh.engines&&p.dsh.engines.dsh)|| (p.peerDependencies&&p.peerDependencies['@deepseek-ai/dsh']) || null, kind: (p.dsh&&p.dsh.bundle)?'bundle':(p.dsh&&p.dsh.client?'client':'plugin') });
}
for (const e of fs.readdirSync(root)) {
  if (e.startsWith('@')) { for (const s of fs.readdirSync(path.join(root,e))) scan(e,s); }
  else scan(null,e);
}
console.log('=== 已装 DSH 插件/客户端包 (' + seen.size + ') ===');
const entries=[...seen.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
for (const [n,v] of entries) console.log('  ' + n.padEnd(46) + (v.version||'?').padEnd(12) + (v.kind||'').padEnd(8) + ' engines=' + (v.engines||'-'));

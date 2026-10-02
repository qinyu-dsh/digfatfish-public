#!/usr/bin/env node
// pre-update-fingerprint.cjs - capture the plugin tree state so a GUI update can be diffed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const NM = (process.env.USERPROFILE || 'C:/Users/<user>') + '/.dsh/profiles/web/node_modules';
const targets = ['@linxin666/dsh-web-all', '@liustack/modlens', '@morlay/better-session', '@morlay/session-rdb', '@morlay/ui-conversation-message-actions', 'dsh-meme', 'dsh-routing-suite', '@omdsh-dev/dsh-genui', 'dsh-at-file', 'dsh-better-sidebar'];
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };
const out = { at: new Date().toISOString(), packages: {}, files: {} };
for (const t of targets) {
  const pj = NM + '/' + t + '/package.json';
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    out.packages[t] = { version: j.version, mtime: fs.statSync(pj).mtime.toISOString() };
  } catch { out.packages[t] = null; }
}
out.files['dsh-meme/client.js'] = sha(NM + '/dsh-meme/client.js');
out.files['@morlay/ui-conversation-message-actions/dist/src-B4HwXsob.mjs'] = sha(NM + '/@morlay/ui-conversation-message-actions/dist/src-B4HwXsob.mjs');
out.files['profile/package.json'] = sha(NM + '/../package.json');
out.files['profile/pnpm-workspace.yaml'] = sha(NM + '/../pnpm-workspace.yaml');
out.files['profile/pnpm-lock.yaml'] = sha(NM + '/../pnpm-lock.yaml');
const f = 'D:/dhs01/dsh-plugin-tools/.fingerprint-pre-update.json';
fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
console.log('fingerprint saved: ' + f);
console.log('  modlens: ' + (out.packages['@liustack/modlens'] || {}).version + ' | meme: ' + (out.packages['dsh-meme'] || {}).version + ' | family: ' + (out.packages['@linxin666/dsh-web-all'] || {}).version);
console.log('  meme client.js sha: ' + out.files['dsh-meme/client.js'] + ' | morlay guard sha: ' + out.files['@morlay/ui-conversation-message-actions/dist/src-B4HwXsob.mjs']);
console.log('  profile trio sha: package.json=' + out.files['profile/package.json'] + ' ws=' + out.files['profile/pnpm-workspace.yaml'] + ' lock=' + out.files['profile/pnpm-lock.yaml']);

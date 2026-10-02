#!/usr/bin/env node
/**
 * post-update-check.cjs - verify the tree after ANY plugin install / GUI update click.
 * Checks: installed versions, modlens interface surface, the morlay route-guard patch,
 * the dsh-meme draft fix (auto-repairs if wiped), profile deps/bundles, service health.
 * Usage: node post-update-check.cjs [--fix]
 */
const fs = require('node:fs');
const cp = require('node:child_process');
const HOME = process.env.USERPROFILE;
const PROFILE = HOME + '/.dsh/profiles/web';
const NM = PROFILE + '/node_modules';
const FIX = process.argv.includes('--fix');
const out = { at: new Date().toISOString(), checks: [] };
const ck = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail: String(detail) }); };

const ver = (p) => { try { return JSON.parse(fs.readFileSync(NM + '/' + p + '/package.json', 'utf8')).version; } catch { return null; } };
const has = (file, needle) => { try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; } };

// 1) versions
const versions = {};
for (const p of ['@linxin666/dsh-web-all', '@liustack/modlens', '@morlay/better-session', 'dsh-meme', 'dsh-routing-suite', '@omdsh-dev/dsh-genui', 'dsh-at-file']) versions[p] = ver(p);
out.versions = versions;
ck('modlens 版本', versions['@liustack/modlens'] !== null, versions['@liustack/modlens']);
ck('modlens 有 prepareCall', has(NM + '/@liustack/modlens/dsh/index.js', 'prepareCall'), 'dsh/index.js');
ck('modlens 有 imageRequestPricing', has(NM + '/@liustack/modlens/dsh/index.js', 'imageRequestPricing'), 'dsh/index.js');

// 2) morlay route guard (pnpm patch must survive installs)
const guardFile = NM + '/@morlay/ui-conversation-message-actions';
let guardHit = false;
try {
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = d + '/' + e.name; if (e.isDirectory()) walk(q); else if (/\.(js|mjs)$/.test(e.name) && fs.readFileSync(q, 'utf8').includes('connectionRouteDispose')) guardHit = true; } };
  walk(guardFile);
} catch {}
ck('morlay 路由守卫在位', guardHit, guardFile);
try {
  const YAML = require(PROFILE + '/node_modules/yaml');
  const ws = YAML.parse(fs.readFileSync(PROFILE + '/pnpm-workspace.yaml', 'utf8'));
  const pd = ws.patchedDependencies || {};
  ck('patchedDependencies 有 morlay', Object.keys(pd).some((k) => k.includes('morlay')), JSON.stringify(pd));
  ck('patchedDependencies 无失效条目', Object.keys(pd).every((k) => fs.existsSync(PROFILE + '/' + pd[k])), JSON.stringify(pd));
} catch (e) { ck('patchedDependencies 可解析', false, e.message); }

// 3) dsh-meme draft fix (a pnpm install can wipe it)
let memeFixed = has(NM + '/dsh-meme/client.js', 'liveDraft0');
if (!memeFixed && FIX) { try { cp.execSync('node "D:/dhs01/dsh-plugin-tools/fix-meme-draft.cjs"', { stdio: 'pipe' }); memeFixed = has(NM + '/dsh-meme/client.js', 'liveDraft0'); } catch {} }
ck('dsh-meme 草稿修复在位', memeFixed, memeFixed ? 'ok' : '需运行 fix-meme-draft.cjs' + (FIX ? '（已尝试自动修复）' : '（加 --fix 可自动修）'));

// 4) profile wiring untouched
try {
  const pj = JSON.parse(fs.readFileSync(PROFILE + '/package.json', 'utf8'));
  out.bundles = pj.dsh?.profile?.bundles;
  out.deps = Object.entries(pj.dependencies || {});
  ck('bundles 8 层', (out.bundles || []).length === 8, JSON.stringify(out.bundles));
  ck('deps 7 项', out.deps.length === 7, out.deps.map(([k, v]) => k + '@' + v).join(', '));
} catch (e) { ck('profile package.json', false, e.message); }

// 5) service health + pid
try {
  const net = cp.execSync('netstat -ano', { encoding: 'utf8' }).split(/\r?\n/).find((l) => /:3080\s/.test(l) && /LISTENING/i.test(l));
  out.serverPid = net ? Number(net.trim().split(/\s+/).pop()) : null;
} catch {}
console.log('（健康检查走 API，见下）');

(async () => {
  for (const [name, url, pick] of [
    ['failures=[]', 'http://127.0.0.1:3080/api/plugin-manager/failures', (j) => Array.isArray(j.items) && j.items.length === 0],
    ['safeMode=false', 'http://127.0.0.1:3080/api/plugin-manager/failures', (j) => j.safeMode === false],
  ]) {
    try { const j = await (await fetch(url)).json(); ck(name, pick(j), JSON.stringify(j).slice(0, 120)); }
    catch (e) { ck(name, false, e.message); }
  }
  const bad = out.checks.filter((c) => !c.ok);
  console.log('=== post-update-check ===');
  console.log('versions: ' + JSON.stringify(out.versions));
  console.log('serverPid: ' + out.serverPid + ' | bundles: ' + (out.bundles || []).length + ' | deps: ' + (out.deps || []).length);
  for (const c of out.checks) console.log((c.ok ? '  ✅ ' : '  ❌ ') + c.name.padEnd(30) + (c.ok ? '' : '  ' + c.detail));
  fs.writeFileSync('D:/dhs01/dsh-plugin-tools/post-update-check.report.json', JSON.stringify(out, null, 2), 'utf8');
  console.log(bad.length === 0 ? 'VERDICT: ALL GREEN' : 'VERDICT: ' + bad.length + ' CHECK(S) FAILED');
  process.exit(bad.length === 0 ? 0 : 1);
})();

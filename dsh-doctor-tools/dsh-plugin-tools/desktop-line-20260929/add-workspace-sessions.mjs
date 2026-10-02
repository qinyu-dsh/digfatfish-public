// add-workspace-sessions.mjs  (2026-09-29)
// Add session ids to a workspace row of the real home's storages\workspace.json, using the probe
// home's index purely to learn which workspace path each carried-over session belongs to.
// JSON is edited with Node on purpose: PowerShell's ConvertFrom-Json/ConvertTo-Json round trip has
// silently dropped edits on this file before (see DSH调试经验.md §13).
//
// Usage:
//   node add-workspace-sessions.mjs --real-ws <real workspace.json> --probe-ws <probe workspace.json>
//        --ids <session-id>[,<session-id>...] [--dry-run]
//
// Prints one JSON summary line and exits 0 on success (or on a clean no-op).

import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const dryRun = argv.includes('--dry-run');
const realWsPath = arg('--real-ws');
const probeWsPath = arg('--probe-ws');
const ids = (arg('--ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const out = { realWs: realWsPath, ids, added: [], skipped: [], workspaces: [], dryRun, ok: false };

if (!realWsPath || !probeWsPath || ids.length === 0) {
  out.error = 'usage: --real-ws <file> --probe-ws <file> --ids <id[,id]> [--dry-run]';
  console.log(JSON.stringify(out));
  process.exit(2);
}

const real = readJson(realWsPath);
const probe = readJson(probeWsPath);

const workspacesOf = (doc) => Object.entries(doc?.tables?.workspaces ?? {}).map(([id, row]) => ({ id, row }));
const realWorkspaces = workspacesOf(real);
const probeWorkspaces = workspacesOf(probe);


// which workspace path does each id belong to, per the probe index?
const pathOf = new Map();
for (const { row } of probeWorkspaces) {
  for (const id of row?.sessionIds ?? []) if (ids.includes(id)) pathOf.set(id, row.path);
}
for (const id of ids) if (!pathOf.has(id)) pathOf.set(id, null); // unknown -> fall back to default workspace

const targetOf = (path) => {
  if (path) {
    const hit = realWorkspaces.find(({ row }) => typeof row?.path === 'string'
      && row.path.replace(/[\\/]+$/, '').toLowerCase() === path.replace(/[\\/]+$/, '').toLowerCase());
    if (hit) return hit;
  }
  const def = real?.global?.defaultWorkspaceId;
  return realWorkspaces.find(({ id }) => id === def) ?? realWorkspaces[0] ?? null;
};

for (const id of ids) {
  const target = targetOf(pathOf.get(id));
  if (!target) { out.skipped.push({ id, reason: 'the real index has no workspace to attach it to' }); continue; }
  const list = Array.isArray(target.row.sessionIds) ? target.row.sessionIds : (target.row.sessionIds = []);
  if (list.includes(id)) { out.skipped.push({ id, reason: `already listed in workspace "${target.row.title}"` }); continue; }
  if (!dryRun) {
    list.push(id);
    target.row.updatedAt = new Date().toISOString();
  }
  out.added.push(id);
  out.workspaces.push({ id: target.id, title: target.row.title, path: target.row.path });
}

if (!dryRun && out.added.length > 0) {
  const backup = `${realWsPath}.bak-restore-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
  fs.copyFileSync(realWsPath, backup);
  out.backup = backup;
  fs.writeFileSync(realWsPath, `${JSON.stringify(real, null, 2)}\n`, 'utf8');

  // verify the write actually landed instead of trusting the round trip
  const check = readJson(realWsPath);
  const listed = new Set(workspacesOf(check).flatMap(({ row }) => row?.sessionIds ?? []));
  const missing = out.added.filter((id) => !listed.has(id));
  out.verified = missing.length === 0;
  if (missing.length > 0) { out.error = `write did not stick for: ${missing.join(', ')}`; console.log(JSON.stringify(out)); process.exit(3); }
} else {
  out.verified = true;
}

out.ok = true;
console.log(JSON.stringify(out));

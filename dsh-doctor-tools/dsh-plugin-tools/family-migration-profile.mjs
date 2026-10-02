// family-migration-profile.mjs — profile surgery for the 0.1.5 + dsh-web-all migration.
//
// Dry-run by default: prints the exact diff. Pass --apply to write (each file gets a
// .bak-family-migration-<stamp> copy first). Idempotent: re-running --apply is a no-op.
//
// What it changes (profile = %USERPROFILE%\.dsh\profiles\web):
//   1. package.json  — swap the family package name, drop replaced plugins, add the
//                      RDB session bundle, and rewrite dsh.profile.bundles to match.
//   2. cordis.patch.yml — drop the two blocks that are now stale (dsh-balance config,
//                      better-session opt-in ids) and enable the opt-in family rows we
//                      depend on (liangshen = the default agent preset, session-archive).
//   3. pnpm-workspace.yaml — drop patchedDependencies (the modlens 3.18.2 prepareCall
//                      patch is obsolete: modlens 3.26.1 implements prepareCall itself).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Hand-written pnpm patch: idempotence guard for the /api/session-editor fetch route. */
const PATCH_SRC = path.join(HERE, "patches", "@morlay-ui-conversation-message-actions-0.0.18-route-guard.patch");
const PATCH_KEY = "@morlay/ui-conversation-message-actions@0.0.18";

const HOME = process.env.USERPROFILE || "C:\\Users\\<user>";
const PROFILE = path.join(HOME, ".dsh", "profiles", "web");
const APPLY = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const DEPS_ADD = {
  "@linxin666/dsh-web-all": "0.3.23",
  "@morlay/better-session": "0.0.20",
  "@liustack/modlens": "3.26.1",
  "dsh-meme": "0.1.43"
};
const DEPS_DROP = ["@linxin666/dsh-web-ui-all", "dsh-balance", "@mlgbnb/dsh-archive-manager"];
const BUNDLES_DROP = ["dsh-balance", "dsh-at-file"]; // at-file: unmounted for the window (it is disabled anyway); its 0.1.5 source patch is already applied, re-add after verification
const BUNDLES_ADD_AFTER = { "@linxin666/dsh-web-ui-all": "@linxin666/dsh-web-all" };
const BUNDLES_APPEND = ["@morlay/better-session"];

const changes = [];
function record(file, what, before, after) { changes.push({ file, what, before, after }); }
function writeWithBackup(file, next) {
  if (!APPLY) return;
  const bak = file + ".bak-family-migration-" + stamp;
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, next, "utf8");
}

// ---------- 1. package.json ----------
const pkgPath = path.join(PROFILE, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
const deps = pkg.dependencies ?? {};
for (const d of DEPS_DROP) if (deps[d] !== undefined) { record("package.json", "drop dep " + d + " (" + deps[d] + ")", d, "(removed)"); delete deps[d]; }
for (const [k, v] of Object.entries(DEPS_ADD)) {
  const was = deps[k];
  if (was !== v) { record("package.json", "set dep " + k, String(was), v); deps[k] = v; }
}
pkg.dependencies = deps;
const before = [...(pkg.dsh?.profile?.bundles ?? [])];
let bundles = before.filter((b) => !BUNDLES_DROP.includes(b)).map((b) => BUNDLES_ADD_AFTER[b] ?? b);
for (const b of BUNDLES_APPEND) if (!bundles.includes(b)) bundles.push(b);
const deps2 = Object.keys(deps).filter((d) => !String(deps[d]).startsWith("link:"));
const missing = deps2.filter((d) => !bundles.includes(d));
if (missing.length) bundles = bundles.concat(missing); // keep every npm dep mounted
if (JSON.stringify(bundles) !== JSON.stringify(before)) record("package.json", "bundles", before.join(" , "), bundles.join(" , "));
pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles } };
const pkgNext = JSON.stringify(pkg, null, 2) + "\n";
writeWithBackup(pkgPath, pkgNext);

// ---------- 2. cordis.patch.yml ----------
const patchPath = path.join(PROFILE, "cordis.patch.yml");
const patchText = fs.readFileSync(patchPath, "utf8").replace(/^\uFEFF/, "");
const lines = patchText.split(/\r?\n/);
const keep = [];
// Two stale blocks have to go, and both need an explicit end condition:
//   - the dsh-balance price block (the plugin is dropped in this migration);
//   - the better-session opt-in block, which flips ids (web-ui-session-*) that only
//     existed in the OLD family patch. Running off the closing marker (not "the next
//     comment") is what keeps those four entries from surviving as dead references.
let mode = "";
for (const l of lines) {
  if (/^# >>> better-session opt-in/.test(l)) { mode = "bettersession"; continue; }
  if (mode === "bettersession") { if (/^# <<< better-session opt-in/.test(l)) mode = ""; continue; }
  if (/^#/.test(l) && /(dsh-balance|定价|峰谷)/.test(l)) continue;   // stale comments of the price block
  if (/^- id:\s*dsh-balance\s*$/.test(l)) { mode = "balance"; continue; }
  if (mode === "balance") { if (/^- id:/.test(l)) { mode = ""; } else { continue; } }
  keep.push(l);
}
let patchNext = keep.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
const optIn = [
  "",
  "# 2026-09-19 family migration (dsh-web-all 0.3.23 + core 0.1.5-rc.1):",
  "# the new family ships these opt-in rows disabled; we rely on both.",
  "#   web-ui-liangshen        -> settings.yaml agent-presets.default = liangshen",
  "#   web-ui-session-archive  -> replaces @mlgbnb/dsh-archive-manager (RDB-aware delete)",
  "- id: web-ui-liangshen",
  "  disabled: false",
  "- id: web-ui-session-archive",
  "  disabled: false",
  "# The old opt-in block for web-ui-session-branch / -rdb / conversation-message-actions",
  "# is obsolete: those rows now ship enabled inside @morlay/better-session itself.",
  ""
].join("\n");
patchNext += optIn;
if (patchNext !== patchText) record("cordis.patch.yml", "rewrite (drop 2 stale blocks, enable 2 opt-in rows)", patchText.length + " chars", patchNext.length + " chars");
writeWithBackup(patchPath, patchNext);

// ---------- 3. pnpm-workspace.yaml ----------
// Keep every existing patchedDependencies entry (the modlens prepareCall patch is one of
// them) and make sure ours is present. The first implementation replaced the whole block,
// which silently dropped the modlens entry.
const wsPath = path.join(PROFILE, "pnpm-workspace.yaml");
const wsText = fs.readFileSync(wsPath, "utf8").replace(/^\uFEFF/, "");
const wsLines = wsText.split(/\r?\n/);
const pdEntries = new Map();
const wsKeep = [];
let pdHeaderAt = -1;
for (let i = 0; i < wsLines.length; i++) {
  const l = wsLines[i];
  if (/^patchedDependencies:\s*\{\s*\}\s*$/.test(l)) { pdHeaderAt = wsKeep.length; wsKeep.push("patchedDependencies:"); continue; }
  if (/^patchedDependencies:\s*$/.test(l)) {
    pdHeaderAt = wsKeep.length;
    wsKeep.push(l);
    for (let j = i + 1; j < wsLines.length; j++) {
      const e = wsLines[j];
      if (!/^\s+/.test(e)) break;
      const em = e.match(/^\s{2}('?[^':]+'?):\s*(\S+)\s*$/);
      if (em) pdEntries.set(em[1].replace(/^'|'$/g, ""), em[2]);
      i = j;
    }
    continue;
  }
  wsKeep.push(l);
}
pdEntries.set(PATCH_KEY, "patches/" + path.basename(PATCH_SRC));
// A patchedDependencies entry that matches no installed version makes pnpm fail the whole
// install (ERR_PNPM_UNUSED_PATCH), so drop the modlens 3.18.2 patch entry whenever this
// migration bumps modlens to a release that already ships prepareCall/imageRequestPricing.
const modlensTarget = DEPS_ADD["@liustack/modlens"];
if (modlensTarget) {
  for (const key of [...pdEntries.keys()]) {
    if (key.startsWith("@liustack/modlens@") && key !== "@liustack/modlens@" + modlensTarget) {
      pdEntries.delete(key);
      record("pnpm-workspace.yaml", "drop stale patch entry " + key + " (modlens now " + modlensTarget + ")", key, "(removed)");
    }
  }
}
if (pdHeaderAt >= 0) {
  const block = [];
  for (const [k, v] of pdEntries) block.push("  '" + k + "': " + v);
  wsKeep.splice(pdHeaderAt + 1, 0, ...block);
} else {
  const block = ["patchedDependencies:"];
  for (const [k, v] of pdEntries) block.push("  '" + k + "': " + v);
  wsKeep.unshift(...block, "");
}
const wsNext = wsKeep.join("\n").replace(/\n{3,}/g, "\n\n");
if (wsNext !== wsText) record("pnpm-workspace.yaml", "patchedDependencies: " + [...pdEntries.keys()].join(", "), "see file", [...pdEntries.keys()].length + " entries");
writeWithBackup(wsPath, wsNext);

// ssh2's optional crypto binding cannot compile here (no VS build tools) and its node-gyp
// child is what flashes a console window during an install; on 2026-09-16 a flashing window
// was closed by hand and the scheduled task died with 0xC000013A. Keep that build off.
const wsFinal = fs.readFileSync(wsPath, "utf8");
if (/^\s*ssh2:\s*true\s*$/m.test(wsFinal)) {
  const flipped = wsFinal.replace(/^(\s*)ssh2:\s*true\s*$/m, "$1ssh2: false");
  if (APPLY) fs.writeFileSync(wsPath, flipped, "utf8");
  record("pnpm-workspace.yaml", "allowBuilds.ssh2 true -> false (no node-gyp console flash)", "ssh2: true", "ssh2: false");
}
// ---------- report ----------
console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY-RUN", profile: PROFILE, changes }, null, 1));
if (!APPLY) console.log("\n(dry-run: nothing written. re-run with --apply to commit.)");

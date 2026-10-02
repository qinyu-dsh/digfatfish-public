#!/usr/bin/env node
/**
 * dsh-keepalive.cjs - cheap idempotent port probe for the "DSH Server Keepalive" task.
 * Healthy (port listening) -> exit 0 in ~1 s, nothing else touched.
 * Not listening -> spawn start-server.ps1 hidden, guarded by a self-expiring lock file
 * so two runs can never race into two server instances (that race cost us an outage on
 * 2026-09-22 20:07: the loser of the .credentials.yaml.lock fight crashed).
 * 2026-09-22: prefers PowerShell 7 (pwsh) - it writes UTF-8 without a BOM and keeps the
 * whole dsh-server.log single-encoding, so the launch token stays greppable.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cp = require('node:child_process');

const PORT = Number(process.env.KEEPALIVE_PORT || 3080);
const HOST = '127.0.0.1';
const LOCK = path.join(__dirname, '.keepalive-start.lock');
const LAUNCHER = 'D:\\dhs01\\dsh-desktop\\start-server.ps1';
const LOCK_TTL_MS = 180000;
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const SHELL = fs.existsSync(PWSH) ? PWSH : 'powershell.exe';

const lockFresh = () => {
  try { return (Date.now() - fs.statSync(LOCK).mtimeMs) < LOCK_TTL_MS; } catch { return false; }
};

const probe = (cb) => {
  const s = net.connect({ port: PORT, host: HOST });
  let done = false;
  const fin = (up) => { if (done) return; done = true; try { s.destroy(); } catch {} cb(up); };
  s.setTimeout(1500);
  s.on('connect', () => fin(true));
  s.on('error', () => fin(false));
  s.on('timeout', () => fin(false));
};

probe((up) => {
  if (up) process.exit(0);
  if (lockFresh()) { console.log('keepalive: start already in flight, skip'); process.exit(0); }
  try { fs.writeFileSync(LOCK, String(Date.now())); } catch {}
  const child = cp.spawn(SHELL, ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER], { stdio: 'ignore', windowsHide: true });
  console.log('keepalive: port ' + PORT + ' closed -> launcher started via ' + path.basename(SHELL) + ' (pid ' + child.pid + ')');
  child.on('exit', (code) => { try { fs.unlinkSync(LOCK); } catch {} process.exit(code || 0); });
});

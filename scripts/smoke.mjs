// Cross-platform smoke test: start hub-cli in disabled mode on a random port,
// verify /_health and /_status respond, then stop it by PID (the child we own).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.join(process.cwd(), 'lib', 'hub-cli.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-smoke-'));
const port = 19300 + Math.floor(Math.random() * 500);
const statusFile = path.join(home, 'status.json');

const child = spawn(
  process.execPath,
  [cli, '--disabled', '--port', String(port), '--status-file', statusFile],
  { env: { ...process.env, DSH_HOME: home }, stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  return null;
}

let ok = false;
try {
  const health = await waitHealth();
  if (!health?.ok) throw new Error('health check timed out');
  const status = await fetch(`http://127.0.0.1:${port}/_status`, { signal: AbortSignal.timeout(2000) });
  if (!status.ok) throw new Error(`status HTTP ${status.status}`);
  const peer = await fetch(`http://127.0.0.1:${port}/_peer`, { signal: AbortSignal.timeout(2000) });
  if (!peer.ok) throw new Error(`peer HTTP ${peer.status}`);
  console.log('smoke ok:', JSON.stringify({ port, health, peerVersion: (await peer.json()).version }));
  ok = true;
} catch (err) {
  console.error('smoke failed:', err.message);
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  try { child.kill('SIGKILL'); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

process.exit(ok ? 0 : 1);

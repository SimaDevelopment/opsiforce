import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const READY_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 4_000;
const REPORT_INTERVAL_MS = 20_000;
const API_TIMEOUT_MS = 30_000;
const TILT_UI_URL = 'https://tilt.opsiforce.localtest.me';

const tilde = (path) => (path.startsWith(homedir()) ? path.replace(homedir(), '~') : path);

function ensureCluster(ctx) {
  const host = ctx.tryCapture('minikube', ['status', '-f', '{{.Host}}']);
  if (host === 'Running') return;
  if (host === 'Stopped') {
    throw new Error('minikube is stopped. Resume it with `minikube start`, then re-run `yarn dev`.');
  }
  throw new Error('minikube is not running — `tilt up` needs a live cluster. Run `yarn dev --reset` then `yarn dev`.');
}

function logTail(file) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-12).join('\n');
  } catch {
    return '';
  }
}

function tiltRunning(ctx) {
  return ctx.tryCapture('tilt', ['get', 'session']) !== null;
}

function startTilt(ctx, backendDir) {
  mkdirSync(ctx.paths.logs, { recursive: true });
  const logFile = join(ctx.paths.logs, 'tilt.log');
  const out = openSync(logFile, 'a');
  const child = spawn('tilt', ['up', '--host=0.0.0.0'], {
    cwd: backendDir,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, OPSIFORCE_STANDALONE: '1' },
  });
  if (typeof child.pid === 'number') writeFileSync(ctx.paths.tiltPid, `${child.pid}\n`);
  return { child, logFile };
}

function resourceStatuses(ctx) {
  const json = ctx.tryCapture('tilt', ['get', 'uiresources', '-o', 'json']);
  if (!json) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const statuses = {};
  for (const item of items) {
    const name = item?.metadata?.name;
    if (typeof name === 'string') statuses[name] = item?.status?.runtimeStatus ?? 'none';
  }
  return statuses;
}

async function awaitTiltApi(ctx) {
  const deadline = Date.now() + API_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tiltRunning(ctx)) return true;
    await delay(1_000);
  }
  return false;
}

async function waitForReady(ctx, required) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastReport = 0;
  while (Date.now() < deadline) {
    const statuses = resourceStatuses(ctx);
    if (statuses) {
      const pending = required.filter((name) => statuses[name] !== 'ok');
      if (pending.length === 0) return true;
      if (Date.now() - lastReport > REPORT_INTERVAL_MS) {
        ctx.note(`waiting on: ${pending.join(', ')}…`);
        lastReport = Date.now();
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

export async function run(ctx) {
  ensureCluster(ctx);
  if (!ctx.commandExists('tilt')) {
    throw new Error('tilt is not installed — the prerequisites step installs it. Re-run `yarn dev`.');
  }
  const backendDir = join(ctx.paths.packageRoot, 'backend');

  if (tiltRunning(ctx)) {
    ctx.note('a Tilt session is already running — reconciling against the current Tiltfile.');
  } else {
    const { child, logFile } = startTilt(ctx, backendDir);
    let exited = null;
    child.on('exit', (code, signal) => {
      exited = signal ?? code;
    });
    child.on('error', (error) => {
      exited = error.message;
    });
    child.unref();

    if (!(await awaitTiltApi(ctx))) {
      if (exited !== null) {
        const tail = logTail(logFile);
        throw new Error(
          `tilt up exited before coming online (${exited}).${tail ? `\n\n${tail}` : ''}\n\nFix the Tiltfile and re-run \`yarn dev\`.`
        );
      }
      ctx.warn('Tilt is slow to come online; continuing to wait for resources.');
    } else {
      ctx.note(`tilt up started (pid ${child.pid}); logs at ${tilde(logFile)}.`);
    }
  }

  const required = ['opsiforce-backend', 'opsiforce-proxy', 'frontend'];

  ctx.note('bringing up in-cluster workloads and host processes (first run can take a few minutes)…');
  if (await waitForReady(ctx, required)) {
    ctx.note('all core services report healthy.');
  } else {
    const statuses = resourceStatuses(ctx) ?? {};
    const pending = required.filter((name) => statuses[name] !== 'ok').map((name) => `${name} (${statuses[name] ?? 'unknown'})`);
    ctx.warn(`Not healthy yet: ${pending.join(', ')}. Watch them in the Tilt UI and restart any that need it.`);
  }

  ctx.note(`one UI for every process — logs, status, and per-service restart — at ${TILT_UI_URL} (or http://localhost:10350).`);
}

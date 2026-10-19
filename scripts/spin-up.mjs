#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { run as runBifrost } from './steps/bifrost.mjs';
import { run as runDatabase } from './steps/database.mjs';
import { run as runEmail } from './steps/email.mjs';
import { run as runImages } from './steps/images.mjs';
import { run as runInfra } from './steps/infra.mjs';
import { run as runInstall } from './steps/install.mjs';
import { run as runLlm } from './steps/llm.mjs';
import { run as runOpen } from './steps/open.mjs';
import { run as runPrerequisites } from './steps/prerequisites.mjs';
import { run as runResources } from './steps/resources.mjs';
import { run as runTunnel } from './steps/tunnel.mjs';
import { run as runUp } from './steps/up.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS_FILE = join(PACKAGE_ROOT, 'versions.json');

const HOME_DIR = join(homedir(), '.opsiforce');
const STATE_FILE = join(HOME_DIR, 'state.json');
const CONFIG_FILE = join(HOME_DIR, 'config.json');
const LOGS_DIR = join(HOME_DIR, 'logs');
const TUNNEL_PID_FILE = join(HOME_DIR, 'tunnel.pid');
const TILT_PID_FILE = join(HOME_DIR, 'tilt.pid');
const STATE_VERSION = 1;

const STEP_HANDLERS = {
  prerequisites: runPrerequisites,
  resources: runResources,
  infra: runInfra,
  install: runInstall,
  images: runImages,
  database: runDatabase,
  bifrost: runBifrost,
  llm: runLlm,
  email: runEmail,
  tunnel: runTunnel,
  up: runUp,
  open: runOpen,
};

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => paint('1', text);
const dim = (text) => paint('2', text);
const green = (text) => paint('32', text);
const red = (text) => paint('31', text);
const cyan = (text) => paint('36', text);
const yellow = (text) => paint('33', text);

const STEPS = [
  {
    id: 'prerequisites',
    title: 'Prerequisites & pinned tools',
    detail: 'detect/install Homebrew, cluster CLIs, Node, container runtime',
  },
  {
    id: 'resources',
    title: 'Resource sizing & cluster start',
    detail: 'detect host CPU/RAM, prompt, minikube start (pinned k8s)',
  },
  { id: 'tunnel', title: 'Start the network tunnel', detail: 'minikube tunnel (one sudo prompt — up front)' },
  {
    id: 'infra',
    title: 'Infra: data stores, ingress, TLS',
    detail: 'helm postgres/redis/traefik, mkcert wildcard cert',
  },
  { id: 'install', title: 'Install workspace dependencies', detail: 'yarn install (virgin PnP)' },
  { id: 'images', title: 'Build images into the cluster', detail: 'agent, runtime-proxy, backend' },
  { id: 'database', title: 'Create databases & migrate', detail: 'opsiforce + bifrost databases, drizzle migrate' },
  { id: 'bifrost', title: 'Install the LLM gateway', detail: 'helm Bifrost + admin secrets' },
  { id: 'llm', title: 'Connect an LLM', detail: 'ChatGPT subscription or OpenAI key' },
  { id: 'email', title: 'Local email testing', detail: 'optional mail mock — off by default' },
  { id: 'up', title: 'Bring the stack up', detail: 'tilt up — in-cluster + host processes' },
  { id: 'open', title: 'Open Opsiforce', detail: 'open https://opsiforce.localtest.me' },
];

const STEP_COUNT = STEPS.length;
const LABEL_WIDTH = `${STEP_COUNT}/${STEP_COUNT}`.length;
const NUM_WIDTH = `${STEP_COUNT}`.length;
const INDENT = ' '.repeat(2 + LABEL_WIDTH + 2);

const tildePath = (path) => (path.startsWith(homedir()) ? path.replace(homedir(), '~') : path);
const nowIso = () => new Date().toISOString();

function heading(text) {
  console.log('');
  console.log(`  ${bold(text)}`);
  console.log('');
}

function note(text) {
  console.log(`${INDENT}${dim('↳ ' + text)}`);
}

function warn(text) {
  console.log(`  ${yellow('!')} ${text}`);
}

function defaultState() {
  return { version: STATE_VERSION, completed: {}, fingerprints: {} };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function findUp(name, fromDir) {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function hashFile(file) {
  try {
    return sha256(readFileSync(file));
  } catch {
    return 'missing';
  }
}

function hashDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 'missing';
  }
  const parts = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    parts.push(entry.isDirectory() ? `${entry.name}/${hashDir(full)}` : `${entry.name}:${hashFile(full)}`);
  }
  return sha256(parts.join('\n'));
}

// Reconciler steps re-run when the inputs they apply change, so a later `yarn dev`
// (e.g. after a branch update) actually installs new deps, rebuilds bumped images,
// applies new migrations, and reconciles provider/value changes instead of skipping.
const STEP_FINGERPRINTS = {
  infra: () => sha256(`${hashFile(join(PACKAGE_ROOT, 'scripts', 'steps', 'infra.mjs'))}:${hashDir(join(PACKAGE_ROOT, 'helm', 'local-infra'))}`),
  install: () => hashFile(findUp('yarn.lock', PACKAGE_ROOT) ?? join(PACKAGE_ROOT, 'yarn.lock')),
  images: () => hashFile(join(PACKAGE_ROOT, 'agent-config', 'agent-image-version.json')),
  database: () => hashDir(join(PACKAGE_ROOT, 'backend', 'db', 'migrations')),
  bifrost: (ctx) =>
    sha256(`${hashFile(join(PACKAGE_ROOT, 'helm', 'bifrost', 'values.local.yaml'))}:${ctx.versions?.exact?.charts?.bifrost ?? ''}`),
  llm: (ctx) => `${ctx.config.llm?.provider ?? 'none'}:${sha256(process.env.OPENAI_API_KEY ?? '')}`,
};

function computeFingerprint(stepId, ctx) {
  const fn = STEP_FINGERPRINTS[stepId];
  if (!fn) return null;
  try {
    return fn(ctx);
  } catch {
    return null;
  }
}

function shouldSkip(state, stepId, forced, ctx) {
  if (!state.completed[stepId] || forced.has(stepId)) return false;
  if (!STEP_FINGERPRINTS[stepId]) return true;
  const current = computeFingerprint(stepId, ctx);
  return current !== null && current === state.fingerprints[stepId];
}

function loadState() {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed?.version === STATE_VERSION && parsed.completed) return parsed;
    warn('State file is from an older version — starting fresh.');
  } catch (error) {
    warn(`Ignoring unreadable state file (${error.message}); starting fresh.`);
  }
  return defaultState();
}

function saveState(state) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  } catch (error) {
    warn(`Ignoring unreadable config file (${error.message}).`);
    return {};
  }
}

function saveConfig(config) {
  if (Object.keys(config).length === 0) return;
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function commandExists(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function capture(command, args = []) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function tryCapture(command, args = []) {
  try {
    return capture(command, args);
  } catch {
    return null;
  }
}

function minikubeRunning() {
  if (!commandExists('minikube')) return false;
  return tryCapture('minikube', ['status', '-f', '{{.Host}}']) === 'Running';
}

function runCommand(command, args = [], options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function print(text) {
  console.log(`${INDENT}${text}`);
}

function loadVersions() {
  if (!existsSync(VERSIONS_FILE)) {
    throw new Error(
      `Versions manifest not found at ${tildePath(VERSIONS_FILE)}; the Quickstart cannot pin tool versions without it.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(VERSIONS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Versions manifest at ${tildePath(VERSIONS_FILE)} is unreadable: ${error.message}`, {
      cause: error,
    });
  }
  if (!parsed?.exact || !parsed?.hostCli) {
    throw new Error(`Versions manifest at ${tildePath(VERSIONS_FILE)} is missing its "exact"/"hostCli" sections.`);
  }
  return parsed;
}

function makePrompts(yes) {
  async function ask(question, { defaultValue = '' } = {}) {
    if (!process.stdin.isTTY) return defaultValue;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise((resolveAnswer) => rl.question(question, resolveAnswer));
      return answer.trim() || defaultValue;
    } finally {
      rl.close();
    }
  }
  async function confirm(question, { defaultYes = true } = {}) {
    if (yes) return true;
    if (!process.stdin.isTTY) return false;
    const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  }
  return { ask, confirm };
}

function maybeInjectFailure(stepId) {
  if (process.env.OPSIFORCE_SPIN_FAIL_AT === stepId) {
    throw new Error(`Simulated failure at step "${stepId}" (OPSIFORCE_SPIN_FAIL_AT).`);
  }
}

function stepContext(config, versions, prompts, flags) {
  return {
    config,
    versions,
    flags,
    note,
    warn,
    print,
    paths: {
      home: HOME_DIR,
      packageRoot: PACKAGE_ROOT,
      logs: LOGS_DIR,
      tunnelPid: TUNNEL_PID_FILE,
      tiltPid: TILT_PID_FILE,
    },
    confirm: prompts.confirm,
    ask: prompts.ask,
    commandExists,
    exists: existsSync,
    capture,
    tryCapture,
    run: runCommand,
    c: { bold, dim, green, red, cyan, yellow },
  };
}

async function runStep(step, ctx) {
  maybeInjectFailure(step.id);
  await STEP_HANDLERS[step.id](ctx);
}

function label(index, color) {
  const text = `${String(index + 1).padStart(NUM_WIDTH, ' ')}/${STEP_COUNT}`;
  return color(text);
}

async function run(versions, prompts, flags) {
  heading('Opsiforce Quickstart');
  console.log(`${INDENT}${dim('macOS & Linux · one-command local setup')}`);
  console.log('');

  const state = loadState();
  state.fingerprints = state.fingerprints ?? {};
  const config = loadConfig();
  const forced = new Set(['tunnel', 'up']);
  if (flags.cpus != null || flags.memoryGb != null) forced.add('resources');
  if (!minikubeRunning()) forced.add('resources');

  for (let i = 0; i < STEP_COUNT; i++) {
    const step = STEPS[i];
    const ctx = stepContext(config, versions, prompts, flags);
    if (shouldSkip(state, step.id, forced, ctx)) {
      console.log(`  ${label(i, dim)}  ${step.title}  ${dim('✓ cached')}`);
      continue;
    }

    console.log(`  ${label(i, cyan)}  ${bold(step.title)}  ${cyan('▶ running…')}`);
    try {
      await runStep(step, ctx);
    } catch (error) {
      console.log(`${INDENT}${red('✗ failed')}`);
      console.log('');
      console.log(`  ${red(error.message)}`);
      console.log('');
      console.log(`  Fix the issue and re-run ${bold('yarn dev')} — it resumes at this step.`);
      saveState(state);
      saveConfig(config);
      process.exitCode = 1;
      return;
    }

    state.completed[step.id] = nowIso();
    state.fingerprints[step.id] = computeFingerprint(step.id, ctx);
    saveState(state);
    saveConfig(config);
    console.log(`${INDENT}${green('✓ done')}`);
  }

  console.log('');
  console.log(`  ${green('✓')} Quickstart complete — the stack is up.`);
  console.log(`  App:     ${bold('https://opsiforce.localtest.me')}  ${dim('(already signed in as the local dev user)')}`);
  console.log(`  Tilt UI: ${bold('https://tilt.opsiforce.localtest.me')}  ${dim('(logs, status, per-service restart)')}`);
  console.log(`  Bifrost: ${bold('https://bifrost.opsiforce.localtest.me')}  ${dim('(LLM gateway — opsiforce-admin / opsiforce-local-admin)')}`);
  console.log(`  Data:    ${dim('postgres localhost:5435 · redis localhost:6382 (Tilt port-forwards)')}`);
}

function killPidFile(file, name) {
  if (!existsSync(file)) return;
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  ${green('✓')} Stopped ${name} (pid ${pid}).`);
  } catch {
    void 0;
  }
}

function stopBackgroundProcesses() {
  killPidFile(TILT_PID_FILE, 'tilt up');
  killPidFile(TUNNEL_PID_FILE, 'minikube tunnel');
  try {
    execFileSync('pkill', ['-f', 'minikube tunnel'], { stdio: 'ignore' });
  } catch {
    void 0;
  }
}

function reset() {
  heading('Resetting the Opsiforce Quickstart');

  stopBackgroundProcesses();

  if (commandExists('minikube')) {
    console.log(`  ${cyan('▶')} Deleting the local cluster (minikube delete)`);
    try {
      execFileSync('minikube', ['delete'], { stdio: 'inherit' });
      console.log(`  ${green('✓')} Cluster deleted.`);
    } catch (error) {
      warn(`minikube delete reported an error: ${error.message}`);
    }
  } else {
    console.log(`  ${dim('○')} minikube not installed — no cluster to delete.`);
  }

  rmSync(HOME_DIR, { recursive: true, force: true });
  console.log(`  ${green('✓')} Cleared ${tildePath(HOME_DIR)}`);
  note(`progress:    ${tildePath(STATE_FILE)}`);
  note(`config:      ${tildePath(CONFIG_FILE)}`);
  note(`logs:        ${tildePath(LOGS_DIR)}`);
  console.log('');
  console.log(`  Next run of ${bold('yarn dev')} starts clean.`);
}

function printUsage() {
  console.log(`${bold('Opsiforce Quickstart')} — one-command local setup (macOS & Linux)`);
  console.log('');
  console.log('Usage:');
  console.log('  yarn dev                 Run the Quickstart (idempotent; resumes after a failed step)');
  console.log('  yarn dev --yes           Run non-interactively, consenting to prerequisite installs');
  console.log('  yarn dev --cpus N        Set the cluster CPU count non-interactively (re-applies on re-run)');
  console.log('  yarn dev --memory G      Set the cluster memory in GB non-interactively (re-applies on re-run)');
  console.log('  yarn dev --reset         Tear down the cluster and clear ~/.opsiforce for a clean first run');
  console.log('  yarn dev --help          Show this message');
  console.log('');
  console.log('Pinned tool versions live in versions.json; refresh them with scripts/capture-baseline.mjs.');
  console.log('State and config live under ~/.opsiforce/ (state.json, config.json).');
  console.log('Set OPSIFORCE_SPIN_FAIL_AT=<step-id> to simulate a step failure when testing resume.');
}

function readValueFlag(arg, argv, index, name) {
  if (arg.includes('=')) return [arg.slice(arg.indexOf('=') + 1), 0];
  const next = argv[index + 1];
  if (next === undefined) throw new Error(`${name} requires a value (e.g. ${name} 6).`);
  return [next, 1];
}

function parsePositiveFlag(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer (got "${value}").`);
  return parsed;
}

function parseArgs(argv) {
  const options = { reset: false, help: false, yes: false, cpus: null, memoryGb: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--cpus' || arg.startsWith('--cpus=')) {
      const [value, consumed] = readValueFlag(arg, argv, i, '--cpus');
      options.cpus = parsePositiveFlag(value, '--cpus');
      i += consumed;
    } else if (arg === '--memory' || arg.startsWith('--memory=')) {
      const [value, consumed] = readValueFlag(arg, argv, i, '--memory');
      options.memoryGb = parsePositiveFlag(value, '--memory');
      i += consumed;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assertSupportedPlatform() {
  if (process.platform === 'darwin' || process.platform === 'linux') return;
  console.error(red('Opsiforce Quickstart supports macOS and Linux only.'));
  console.error(dim(`Detected platform: ${process.platform}.`));
  process.exit(1);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(red(error.message));
    console.error('');
    printUsage();
    process.exit(1);
  }

  if (options.help) {
    printUsage();
    return;
  }

  assertSupportedPlatform();

  if (options.reset) {
    reset();
    return;
  }

  let versions;
  try {
    versions = loadVersions();
  } catch (error) {
    console.error(red(error.message));
    process.exit(1);
  }

  const prompts = makePrompts(options.yes);
  await run(versions, prompts, { cpus: options.cpus, memoryGb: options.memoryGb, yes: options.yes });
}

main().catch((error) => {
  console.error(red(`Unexpected error: ${error.stack ?? error.message}`));
  process.exit(1);
});

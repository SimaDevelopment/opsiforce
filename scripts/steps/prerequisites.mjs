import { recommendClusterSize } from './resources.mjs';

const HOST_CLIS = [
  // Homebrew is the macOS install mechanism, not a runtime dependency — only
  // require/inspect it there. On Linux the tools come from the system package manager.
  ...(process.platform === 'darwin'
    ? [{ key: 'homebrew', label: 'Homebrew', bin: 'brew', versionArgs: ['--version'] }]
    : []),
  { key: 'minikube', label: 'minikube', bin: 'minikube', versionArgs: ['version', '--short'] },
  { key: 'kubectl', label: 'kubectl', bin: 'kubectl', versionArgs: ['version', '--client'] },
  { key: 'helm', label: 'Helm', bin: 'helm', versionArgs: ['version', '--short'] },
  { key: 'tilt', label: 'Tilt', bin: 'tilt', versionArgs: ['version'] },
  { key: 'mkcert', label: 'mkcert', bin: 'mkcert', versionArgs: ['-version'], companions: ['nss'] },
];

const RUNTIME_NAMES = {
  orbstack: 'OrbStack',
  'desktop-linux': 'Docker Desktop',
  colima: 'colima',
};

const INSTALLED_RUNTIMES = [
  { name: 'OrbStack', test: (ctx) => ctx.exists('/Applications/OrbStack.app'), start: 'open -a OrbStack' },
  { name: 'Docker Desktop', test: (ctx) => ctx.exists('/Applications/Docker.app'), start: 'open -a Docker' },
  { name: 'colima', test: (ctx) => ctx.commandExists('colima'), start: 'colima start' },
  { name: 'podman', test: (ctx) => ctx.commandExists('podman'), start: 'podman machine start' },
];

function parseSemver(text) {
  const match = (text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

function toTuple(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10));
}

function compareSemver(a, b) {
  const left = toTuple(a);
  const right = toTuple(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function classify(version, pin) {
  if (!version) return { status: 'unknown' };
  if (pin?.floor && compareSemver(version, pin.floor) < 0) {
    return { status: 'below-floor', message: `below the tested floor ${pin.floor}` };
  }
  if (pin?.tested && version !== pin.tested) {
    return { status: 'drift', message: `tested with ${pin.tested}` };
  }
  return { status: 'ok' };
}

function detectHostClis(ctx) {
  return HOST_CLIS.map((cli) => {
    if (!ctx.commandExists(cli.bin)) return { ...cli, present: false };
    const version = parseSemver(ctx.tryCapture(cli.bin, cli.versionArgs));
    return { ...cli, present: true, version, ...classify(version, ctx.versions.hostCli[cli.key]) };
  });
}

function detectNode(ctx) {
  const version = process.versions.node;
  const pin = ctx.versions.exact.node;
  const requiredMajor = toTuple(pin)[0];
  if (toTuple(version)[0] < requiredMajor) {
    return {
      label: 'Node',
      present: true,
      version,
      status: 'below-floor',
      message: `pinned to ${pin} (major ${requiredMajor}+)`,
    };
  }
  if (version !== pin) return { label: 'Node', present: true, version, status: 'drift', message: `pinned ${pin}` };
  return { label: 'Node', present: true, version, status: 'ok' };
}

function detectYarn(ctx) {
  const pin = ctx.versions.exact.yarn;
  if (!ctx.commandExists('yarn')) {
    return { label: 'Yarn', present: false, needsCorepack: true, version: null, status: 'missing' };
  }
  const version = parseSemver(ctx.tryCapture('yarn', ['--version']));
  if (version && version !== pin)
    return { label: 'Yarn', present: true, version, status: 'drift', message: `pinned ${pin}` };
  return { label: 'Yarn', present: true, version, status: 'ok' };
}

function friendlyRuntimeName(ctx) {
  const context = ctx.tryCapture('docker', ['context', 'show']);
  if (!context) return 'Docker';
  return RUNTIME_NAMES[context] ?? 'Docker';
}

function detectRuntime(ctx) {
  if (ctx.commandExists('docker')) {
    const server = ctx.tryCapture('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (server) {
      return { status: 'running', name: friendlyRuntimeName(ctx), version: parseSemver(server) ?? server };
    }
  }
  for (const runtime of INSTALLED_RUNTIMES) {
    if (runtime.test(ctx)) return { status: 'stopped', name: runtime.name, start: runtime.start };
  }
  return { status: 'absent' };
}

function statusBadge(ctx, entry) {
  const { c } = ctx;
  switch (entry.status) {
    case 'ok':
      return c.green('✓');
    case 'drift':
      return c.yellow(`drift — ${entry.message}`);
    case 'below-floor':
      return c.yellow(`⚠ ${entry.message}`);
    case 'missing':
      return c.dim('will install');
    case 'running':
      return c.green('reused');
    case 'stopped':
      return c.yellow('stopped');
    case 'absent':
      return c.dim('will install colima');
    default:
      return c.dim('present');
  }
}

function reportTable(ctx, rows) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const versionWidth = Math.max(...rows.map((row) => (row.version ?? '—').length));
  ctx.note(`tooling — pins from versions.json:`);
  for (const row of rows) {
    const label = row.label.padEnd(labelWidth);
    const version = (row.version ?? '—').padEnd(versionWidth);
    ctx.print(`  ${ctx.c.bold(label)}  ${version}  ${statusBadge(ctx, row)}`);
  }
}

function buildPlan(ctx, hostClis, yarn, runtime) {
  const brewFormulas = [];
  for (const cli of hostClis) {
    if (!cli.present) {
      const formula = ctx.versions.hostCli[cli.key]?.formula ?? cli.bin;
      brewFormulas.push(formula, ...(cli.companions ?? []));
    }
  }
  return {
    brewFormulas,
    corepack: Boolean(yarn.needsCorepack),
    colima: runtime.status === 'absent' ? recommendClusterSize() : null,
  };
}

function planIsEmpty(plan) {
  return plan.brewFormulas.length === 0 && !plan.corepack && !plan.colima;
}

function describePlan(ctx, plan) {
  const lines = [];
  if (plan.brewFormulas.length) lines.push(`brew install ${plan.brewFormulas.join(' ')}`);
  if (plan.corepack) lines.push(`corepack enable (provides Yarn ${ctx.versions.exact.yarn})`);
  if (plan.colima)
    lines.push(
      `brew install colima docker, then colima start --cpu ${plan.colima.cpus} --memory ${plan.colima.memoryGb}`
    );
  return lines;
}

async function installPlan(ctx, plan) {
  // Automated installs are macOS/Homebrew-only. On other platforms, point the
  // user at their package manager rather than shelling out to brew.
  if (process.platform !== 'darwin' && (plan.brewFormulas.length || plan.colima)) {
    const tools = [...plan.brewFormulas];
    if (plan.colima) tools.push('a running container runtime (e.g. Docker Engine)');
    throw new Error(
      `Missing prerequisites: ${tools.join(', ')}. Install them with your system package manager and re-run \`yarn dev\`.`
    );
  }
  if (plan.brewFormulas.length) {
    if (!ctx.commandExists('brew')) {
      throw new Error(
        `Homebrew is required to install ${plan.brewFormulas.join(', ')} but isn't on PATH. Install it from https://brew.sh and re-run.`
      );
    }
    ctx.print(ctx.c.cyan(`installing: brew install ${plan.brewFormulas.join(' ')}`));
    ctx.run('brew', ['install', ...plan.brewFormulas]);
  }
  if (plan.corepack) {
    ctx.print(ctx.c.cyan('enabling Yarn via corepack'));
    ctx.run('corepack', ['enable']);
  }
  if (plan.colima) {
    ctx.print(ctx.c.cyan('installing colima (license-free container runtime)'));
    ctx.run('brew', ['install', 'colima', 'docker']);
    ctx.run('colima', ['start', '--cpu', String(plan.colima.cpus), '--memory', String(plan.colima.memoryGb)]);
  }
}

export async function run(ctx) {
  const { note, warn } = ctx;

  const hostClis = detectHostClis(ctx);
  const node = detectNode(ctx);
  const yarn = detectYarn(ctx);
  const runtime = detectRuntime(ctx);

  const missing = hostClis.filter((cli) => !cli.present).map((cli) => ({ ...cli, status: 'missing' }));
  const present = hostClis.filter((cli) => cli.present);

  const runtimeRow = {
    label: 'runtime',
    version: runtime.version ?? runtime.name ?? null,
    status: runtime.status,
  };

  reportTable(ctx, [...present, ...missing, node, yarn, runtimeRow]);

  for (const entry of [...present, node, yarn]) {
    if (entry.status === 'drift')
      warn(`${entry.label} ${entry.version} drifts from the pinned baseline (${entry.message}).`);
    if (entry.status === 'below-floor' && entry !== node) warn(`${entry.label} ${entry.version} is ${entry.message}.`);
  }

  if (node.status === 'below-floor') {
    throw new Error(
      `Node ${node.version} is too old — the Quickstart runs TypeScript entrypoints (e.g. linked-account-proxy/src/main.ts) directly with \`node\`, which needs Node ${ctx.versions.exact.node}. Install or activate it (nvm/fnm, Homebrew, or your package manager) and re-run \`yarn dev\`.`
    );
  }

  if (runtime.status === 'stopped') {
    throw new Error(
      `Found ${runtime.name} installed but not running. Start it (\`${runtime.start}\`) and re-run \`yarn dev\`.`
    );
  }
  if (runtime.status === 'running') {
    note(`reusing the running container runtime: ${runtime.name} ${runtime.version}`);
    ctx.config.containerRuntime = { name: runtime.name, version: runtime.version };
  }

  const plan = buildPlan(ctx, hostClis, yarn, runtime);

  if (planIsEmpty(plan)) {
    note('all prerequisites present at compatible versions — nothing to install.');
    return;
  }

  note('the Quickstart will install:');
  for (const line of describePlan(ctx, plan)) ctx.print(`  ${ctx.c.bold('•')} ${line}`);

  const consented = await ctx.confirm('Install these now?', { defaultYes: true });
  if (!consented) {
    throw new Error(
      'Prerequisite installation declined. Re-run `yarn dev` when ready, or install the tools listed above yourself.'
    );
  }

  await installPlan(ctx, plan);
  note('prerequisites installed.');
}

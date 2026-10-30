import { cpus, totalmem } from 'node:os';

const HOST_RESERVE_CPUS = 2;
const HOST_RESERVE_MEMORY_GB = 8;
const CLUSTER_CPU_RANGE = { min: 4, max: 6 };
const CLUSTER_MEMORY_RANGE_GB = { min: 6, max: 8 };
const FLOOR = { cpus: 4, memoryGb: 6 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hostCores() {
  return cpus().length;
}

function hostMemoryGb() {
  return Math.round(totalmem() / 1024 ** 3);
}

export function recommendClusterSize() {
  return {
    cpus: clamp(hostCores() - HOST_RESERVE_CPUS, CLUSTER_CPU_RANGE.min, CLUSTER_CPU_RANGE.max),
    memoryGb: clamp(hostMemoryGb() - HOST_RESERVE_MEMORY_GB, CLUSTER_MEMORY_RANGE_GB.min, CLUSTER_MEMORY_RANGE_GB.max),
  };
}

function recommendPoolSize(cluster) {
  return cluster.memoryGb >= CLUSTER_MEMORY_RANGE_GB.max ? 1 : 0;
}

function detectVmSize(ctx) {
  const ncpu = Number.parseInt(ctx.tryCapture('docker', ['info', '--format', '{{.NCPU}}']) ?? '', 10);
  const memBytes = Number.parseInt(ctx.tryCapture('docker', ['info', '--format', '{{.MemTotal}}']) ?? '', 10);
  if (!Number.isInteger(ncpu) || ncpu <= 0 || !Number.isInteger(memBytes) || memBytes <= 0) return null;
  return { cpus: ncpu, memoryGb: Math.floor(memBytes / 1024 ** 3) };
}

function vmHint(ctx) {
  const name = ctx.config.containerRuntime?.name ?? '';
  if (/colima/i.test(name)) return 'Resize it with `colima stop && colima start --cpu N --memory G`.';
  if (name) return `Raise ${name}'s CPU/memory in its settings.`;
  return "Raise your container runtime's CPU/memory allocation.";
}

function parsePositiveInt(answer, fallback, ctx, label) {
  const trimmed = (answer ?? '').trim();
  if (!trimmed) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value <= 0) {
    ctx.warn(`Ignoring invalid ${label} "${trimmed}"; using ${fallback}.`);
    return fallback;
  }
  return value;
}

function startCluster(ctx, chosen, previous) {
  const k8sVersion = ctx.versions.exact.kubernetes;
  const host = ctx.tryCapture('minikube', ['status', '-f', '{{.Host}}']);
  if (host === 'Running') {
    const runtime = ctx.tryCapture('kubectl', [
      '--context',
      'minikube',
      'get',
      'nodes',
      '-o',
      'jsonpath={.items[0].status.nodeInfo.containerRuntimeVersion}',
    ]);
    if (runtime && !runtime.startsWith('containerd://')) {
      ctx.warn(
        `minikube runs the ${runtime.split('://')[0]} runtime; production runs containerd. It still works. To match production, run \`yarn dev --reset\` then \`yarn dev\` to recreate the cluster.`
      );
    }
    ctx.note(`minikube already running — reusing it (kubernetes ${k8sVersion} pinned).`);
    if (previous && (previous.cpus !== chosen.cpus || previous.memoryGb !== chosen.memoryGb)) {
      ctx.warn(
        `minikube can't resize a running cluster; ${chosen.cpus} CPU / ${chosen.memoryGb} GB applies after \`yarn dev --reset\`.`
      );
    }
    return;
  }
  ctx.note(
    `starting minikube — kubernetes ${k8sVersion}, ${chosen.cpus} CPU / ${chosen.memoryGb} GB (docker driver, containerd runtime)…`
  );
  ctx.run('minikube', [
    'start',
    '--driver=docker',
    '--container-runtime=containerd',
    `--kubernetes-version=${k8sVersion}`,
    `--cpus=${chosen.cpus}`,
    `--memory=${chosen.memoryGb}g`,
  ]);
}

async function chooseSize(ctx, recommended, previous) {
  const flags = ctx.flags ?? {};
  if (flags.cpus != null || flags.memoryGb != null) {
    const chosen = { cpus: flags.cpus ?? recommended.cpus, memoryGb: flags.memoryGb ?? recommended.memoryGb };
    ctx.note(`size from flags: ${chosen.cpus} CPU / ${chosen.memoryGb} GB.`);
    return chosen;
  }
  const fallback = previous ?? recommended;
  const cpusAnswer = await ctx.ask(`  CPUs [${fallback.cpus}]: `, { defaultValue: String(fallback.cpus) });
  const memoryAnswer = await ctx.ask(`  Memory GB [${fallback.memoryGb}]: `, {
    defaultValue: String(fallback.memoryGb),
  });
  return {
    cpus: parsePositiveInt(cpusAnswer, fallback.cpus, ctx, 'CPUs'),
    memoryGb: parsePositiveInt(memoryAnswer, fallback.memoryGb, ctx, 'Memory GB'),
  };
}

export async function run(ctx) {
  const { note, warn } = ctx;
  const previous = ctx.config.resources;
  const baseline = recommendClusterSize();
  const vm = detectVmSize(ctx);

  let recommended = baseline;
  if (vm && (vm.cpus < baseline.cpus || vm.memoryGb < baseline.memoryGb)) {
    recommended = { cpus: Math.min(baseline.cpus, vm.cpus), memoryGb: Math.min(baseline.memoryGb, vm.memoryGb) };
    warn(
      `Container runtime VM is ${vm.cpus} CPU / ${vm.memoryGb} GB — smaller than the ${baseline.cpus} CPU / ${baseline.memoryGb} GB recommendation. ${vmHint(ctx)} Capping the recommendation to the VM.`
    );
  }

  note(
    `detected ${hostCores()} cores / ${hostMemoryGb()} GB — recommending ${recommended.cpus} CPU / ${recommended.memoryGb} GB (leaves headroom for your editor and browser).`
  );

  const chosen = await chooseSize(ctx, recommended, previous);

  if (chosen.cpus < FLOOR.cpus || chosen.memoryGb < FLOOR.memoryGb) {
    warn(
      `${chosen.cpus} CPU / ${chosen.memoryGb} GB is below the functional floor (${FLOOR.cpus} CPU / ${FLOOR.memoryGb} GB). Opsiforce may be slow or unstable — the Quickstart will continue anyway.`
    );
  }
  if (vm && (chosen.cpus > vm.cpus || chosen.memoryGb > vm.memoryGb)) {
    warn(
      `${chosen.cpus} CPU / ${chosen.memoryGb} GB exceeds the runtime VM (${vm.cpus} CPU / ${vm.memoryGb} GB); the cluster can't use more than the VM provides. ${vmHint(ctx)}`
    );
  }

  const poolSizeOverride = recommendPoolSize(chosen);
  ctx.config.resources = { cpus: chosen.cpus, memoryGb: chosen.memoryGb, poolSizeOverride };

  note(`cluster size: ${chosen.cpus} CPU / ${chosen.memoryGb} GB.`);
  if (poolSizeOverride === 0) {
    note('pending-project pool disabled at this size — the first New Project provisions on demand.');
  } else {
    note(`pending-project pool capped at ${poolSizeOverride}.`);
  }

  startCluster(ctx, chosen, previous);
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND_TAG = 'opsiforce-backend:dev';
const RUNTIME_PROXY_TAG = 'opsiforce-runtime-proxy:dev';
const AGENT_REPO = 'opsiforce-agent';

function ensureCluster(ctx) {
  const host = ctx.tryCapture('minikube', ['status', '-f', '{{.Host}}']);
  if (host === 'Running') return;
  if (host === 'Stopped') {
    throw new Error('minikube is stopped. Resume it with `minikube start`, then re-run `yarn dev`.');
  }
  throw new Error(
    'minikube is not running — the images step builds into the cluster. Run `yarn dev --reset` then `yarn dev` to (re)create the cluster.'
  );
}

function readAgentImageTag(ctx) {
  const file = join(ctx.paths.packageRoot, 'agent-config', 'agent-image-version.json');
  let version;
  try {
    version = JSON.parse(readFileSync(file, 'utf8')).version;
  } catch (error) {
    throw new Error(`Could not read the agent image version from ${file}: ${error.message}`, { cause: error });
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`The agent image version in ${file} must be a non-empty string.`);
  }
  return `${AGENT_REPO}:${version}`;
}

function imageExists(ctx, tag) {
  const listing = ctx.tryCapture('minikube', ['image', 'ls']);
  return Boolean(listing) && listing.includes(tag);
}

function buildImage(ctx, { tag, context, dockerfile, buildArgs, hint, force = false }) {
  if (!force && imageExists(ctx, tag)) {
    ctx.note(`reusing ${tag} — already in the cluster.`);
    return;
  }
  const args = ['build', '--progress=plain', '-t', tag, '-f', dockerfile];
  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`);
  }
  args.push('.');
  ctx.note(`building ${tag}…${hint ? ` ${hint}` : ''}`);
  ctx.run('docker', args, {
    cwd: context,
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
  ctx.note(`loading ${tag} into minikube…`);
  ctx.run('minikube', ['image', 'load', '--daemon', tag]);
}

export function buildAgentImage(ctx, { force = false } = {}) {
  buildImage(ctx, {
    tag: readAgentImageTag(ctx),
    context: ctx.paths.packageRoot,
    dockerfile: 'docker/Dockerfile.agent',
    buildArgs: { OPENCODE_CONFIG: 'agent-config/opencode.local.json' },
    hint: 'the largest image (chromium, code-server, opencode, bun) — first build takes several minutes, then it is cached and reused.',
    force,
  });
}

export async function run(ctx) {
  ensureCluster(ctx);
  const context = ctx.paths.packageRoot;

  buildAgentImage(ctx);

  buildImage(ctx, {
    tag: RUNTIME_PROXY_TAG,
    context,
    dockerfile: 'docker/Dockerfile.runtime-proxy.dev',
  });

  buildImage(ctx, {
    tag: BACKEND_TAG,
    context,
    dockerfile: 'docker/Dockerfile.backend.dev',
  });

  ctx.note('agent, runtime-proxy, and backend images are present in the cluster.');
}

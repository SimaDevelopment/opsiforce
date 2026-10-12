import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  computeManifestHash,
  createServiceRuntime,
  type AnyServiceHandlers,
  type ServiceRuntime,
  unavailableServiceState,
} from '@opsiforce/external-service-sdk/server';
import { readServiceFolder } from '@opsiforce/external-service-sdk/service-folder';

export const BUILT_IN_SERVICES_DIR = 'BUILT_IN_SERVICES_DIR';

const BUILT_IN_STATE = unavailableServiceState(
  'ctx.state is not available to built-in services: they run inside the platform, with no Project to keep it in'
);

export const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export const RESERVED_SERVICE_SLUGS: readonly string[] = ['usage', 'webhooks', 'agent', 'admin', 'services'];

export interface BuiltInServiceFolder {
  slug: string;
  folder: string;
  manifest: ServiceManifest;
  manifestHash: string;
  icon: string | null;
  serviceSkill: string | null;
  runtime: ServiceRuntime;
}

export const SERVICE_SKILL_FILE = 'SKILL.md';

const HANDLERS_FILE = 'handlers.ts';

export function shippedBuiltInServicesDir(): string {
  return join(process.cwd(), '..', 'external-services');
}

async function serviceFolderNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    throw new Error(
      `The Built-in External Services folder is missing at ${dir}; the backend image must ship external-services/`,
      { cause: error }
    );
  }
}

function slugProblem(name: string): string | null {
  if (!SERVICE_SLUG_PATTERN.test(name)) return `the folder name must match ${SERVICE_SLUG_PATTERN.source}`;
  if (RESERVED_SERVICE_SLUGS.includes(name)) return `"${name}" is a reserved name`;
  return null;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readBuiltInService(dir: string, slug: string): Promise<BuiltInServiceFolder | string[]> {
  const folder = join(dir, slug);
  const nameProblem = slugProblem(slug);
  if (nameProblem) return [nameProblem];
  const { json, check } = await readServiceFolder(folder, { origin: 'built_in' });
  if (!check.ok || !check.manifest) {
    return check.problems
      .filter((problem) => problem.severity === 'error')
      .map((problem) => `${problem.path}: ${problem.message}`);
  }
  const icon = check.manifest.icon ? await readFile(join(folder, check.manifest.icon), 'utf8') : null;
  const serviceSkill = await readOptionalFile(join(folder, SERVICE_SKILL_FILE));
  const runtime = await builtInRuntime(folder, json);
  if (typeof runtime === 'string') return [runtime];
  return {
    slug,
    folder,
    manifest: check.manifest,
    manifestHash: computeManifestHash(json),
    icon,
    serviceSkill,
    runtime,
  };
}

async function builtInRuntime(folder: string, json: unknown): Promise<ServiceRuntime | string> {
  const handlersFile = join(folder, HANDLERS_FILE);
  try {
    await access(handlersFile);
  } catch {
    return `${HANDLERS_FILE} is missing`;
  }
  try {
    const loaded = (await import(pathToFileURL(handlersFile).href)) as { default?: AnyServiceHandlers };
    if (!loaded.default) return `${HANDLERS_FILE} has no default export of defineHandlers(...)`;
    return createServiceRuntime({
      manifest: json,
      handlers: loaded.default,
      origin: 'built_in',
      state: () => BUILT_IN_STATE,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function readBuiltInServices(dir: string): Promise<BuiltInServiceFolder[]> {
  const services: BuiltInServiceFolder[] = [];
  const failures: string[] = [];
  for (const slug of await serviceFolderNames(dir)) {
    const read = await readBuiltInService(dir, slug);
    if (Array.isArray(read)) failures.push([`${slug}:`, ...read.map((problem) => `  error ${problem}`)].join('\n'));
    else services.push(read);
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `A Built-in External Service in ${dir} failed to load; run external-service-cli check <folder> --built-in and external-service-cli types <folder> --built-in`,
        ...failures,
      ].join('\n')
    );
  }
  return services;
}

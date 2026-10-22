import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DefinedService, ServiceManifest } from '@opsiforce/external-service-sdk';
import { computeManifestHash, isDefinedService } from '@opsiforce/external-service-sdk/server';
import { readServiceFolder } from '@opsiforce/external-service-sdk/service-folder';

export const BUILT_IN_SERVICES_DIR = 'BUILT_IN_SERVICES_DIR';

export const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export const RESERVED_SERVICE_SLUGS: readonly string[] = ['usage', 'webhooks', 'agent', 'admin', 'services'];

export interface BuiltInServiceFolder {
  slug: string;
  folder: string;
  manifest: ServiceManifest;
  manifestHash: string;
  icon: string | null;
  serviceSkill: string | null;
  defined: DefinedService;
}

export const SERVICE_SKILL_FILE = 'SKILL.md';

const SERVICE_FILE = 'service.ts';

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
  const { json, check } = await readServiceFolder(folder);
  if (!check.ok || !check.manifest) return errorsOf(check.problems);
  const defined = await definedService(folder, json);
  if (typeof defined === 'string') return [defined];
  return {
    slug,
    folder,
    manifest: check.manifest,
    manifestHash: defined.manifestHash,
    icon: await iconOf(folder, check.manifest.icon),
    serviceSkill: await readOptionalFile(join(folder, SERVICE_SKILL_FILE)),
    defined,
  };
}

function errorsOf(problems: readonly { severity: string; path: string; message: string }[]): string[] {
  return problems
    .filter((problem) => problem.severity === 'error')
    .map((problem) => `${problem.path}: ${problem.message}`);
}

async function iconOf(folder: string, icon: string | undefined): Promise<string | null> {
  return icon ? readFile(join(folder, icon), 'utf8') : null;
}

async function definedService(folder: string, json: unknown): Promise<DefinedService | string> {
  const serviceFile = join(folder, SERVICE_FILE);
  try {
    await access(serviceFile);
  } catch {
    return `${SERVICE_FILE} is missing`;
  }
  try {
    const loaded = (await import(pathToFileURL(serviceFile).href)) as { default?: unknown };
    if (!isDefinedService(loaded.default)) return `${SERVICE_FILE} has no default export of defineService(...)`;
    if (loaded.default.manifestHash !== computeManifestHash(json)) {
      return `${SERVICE_FILE} defines the service with a manifest other than service.json`;
    }
    return loaded.default;
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
        `A Built-in External Service in ${dir} failed to load; run external-service-cli check <folder> and external-service-cli types <folder>`,
        ...failures,
      ].join('\n')
    );
  }
  return services;
}

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { ManifestCheckOptions } from '@opsiforce/external-service-sdk';
import { formatProblemPath } from '@opsiforce/external-service-sdk/platform';
import {
  manifestFileName,
  readServiceFolder,
  type ServiceFolderRead,
} from '@opsiforce/external-service-sdk/service-folder';

type FilePlacement = { kind: 'file'; realPath: string } | { kind: 'missing' } | { kind: 'refused' };

async function realFolderOf(folder: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(folder)), basename(folder));
  } catch {
    return null;
  }
}

async function placementOf(folder: string, file: string): Promise<FilePlacement> {
  let realPath: string;
  try {
    realPath = await realpath(join(folder, file));
  } catch {
    return { kind: 'missing' };
  }
  const realFolder = await realFolderOf(folder);
  if (realFolder === null || !realPath.startsWith(realFolder + sep)) return { kind: 'refused' };
  const isFile = await stat(realPath).then(
    (stats) => stats.isFile(),
    () => false
  );
  return isFile ? { kind: 'file', realPath } : { kind: 'refused' };
}

export async function realFileInFolder(folder: string, file: string): Promise<string | null> {
  const placement = await placementOf(folder, file);
  return placement.kind === 'file' ? placement.realPath : null;
}

export async function readFileInFolder(folder: string, file: string): Promise<string | null> {
  const realPath = await realFileInFolder(folder, file);
  if (realPath === null) return null;
  try {
    return await readFile(realPath, 'utf8');
  } catch {
    return null;
  }
}

function declaredIcon(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const icon = typeof parsed === 'object' && parsed !== null ? (parsed as { icon?: unknown }).icon : undefined;
    return typeof icon === 'string' ? icon : null;
  } catch {
    return null;
  }
}

function refusedRead(path: readonly string[], message: string): ServiceFolderRead {
  return {
    json: undefined,
    check: { ok: false, problems: [{ severity: 'error', path: formatProblemPath(path), message }] },
  };
}

export async function readConfinedServiceFolder(
  folder: string,
  options: ManifestCheckOptions
): Promise<ServiceFolderRead> {
  const manifest = await placementOf(folder, manifestFileName);
  if (manifest.kind === 'refused') {
    return refusedRead([], `${manifestFileName} must be a regular file inside the service folder`);
  }
  if (manifest.kind === 'file') {
    const icon = declaredIcon(await readFile(manifest.realPath, 'utf8').catch(() => null));
    if (icon !== null && (await placementOf(folder, icon)).kind === 'refused') {
      return refusedRead(['icon'], 'icon must be a regular file inside the service folder');
    }
  }
  return readServiceFolder(folder, options);
}

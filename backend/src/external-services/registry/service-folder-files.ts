import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { checkServiceManifest, type ManifestProblem } from '@opsiforce/external-service-sdk';
import { formatProblemPath, manifestLimits } from '@opsiforce/external-service-sdk/platform';
import {
  manifestFileName,
  svgIconProblems,
  type ServiceFolderRead,
} from '@opsiforce/external-service-sdk/service-folder';

type OpenedFile = { kind: 'file'; handle: FileHandle } | { kind: 'missing' } | { kind: 'refused' };

const CONFINED_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function realFolderOf(folder: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(folder)), basename(folder));
  } catch {
    return null;
  }
}

async function insidePathOf(realFolder: string, candidate: string): Promise<string | null> {
  const realPath = await realpath(candidate).catch(() => null);
  return realPath !== null && realPath.startsWith(realFolder + sep) ? realPath : null;
}

async function isTheFileAt(handle: FileHandle, realFolder: string, candidate: string): Promise<boolean> {
  const opened = await handle.stat();
  if (!opened.isFile()) return false;
  const currentPath = await insidePathOf(realFolder, candidate);
  if (currentPath === null) return false;
  const current = await stat(currentPath).catch(() => null);
  return current !== null && current.dev === opened.dev && current.ino === opened.ino;
}

async function openInFolder(folder: string, file: string): Promise<OpenedFile> {
  const candidate = join(folder, file);
  const realPath = await realpath(candidate).catch(() => null);
  if (realPath === null) return { kind: 'missing' };
  const realFolder = await realFolderOf(folder);
  if (realFolder === null || !realPath.startsWith(realFolder + sep)) return { kind: 'refused' };
  let handle: FileHandle;
  try {
    handle = await open(realPath, CONFINED_OPEN_FLAGS);
  } catch {
    return { kind: 'refused' };
  }
  if (await isTheFileAt(handle, realFolder, candidate).catch(() => false)) return { kind: 'file', handle };
  await handle.close();
  return { kind: 'refused' };
}

async function withFileInFolder<T>(
  folder: string,
  file: string,
  read: (handle: FileHandle) => Promise<T>
): Promise<T | 'missing' | 'refused'> {
  const opened = await openInFolder(folder, file);
  if (opened.kind !== 'file') return opened.kind;
  try {
    return await read(opened.handle);
  } catch {
    return 'refused';
  } finally {
    await opened.handle.close();
  }
}

export async function readFileInFolder(folder: string, file: string): Promise<string | null> {
  const read = await withFileInFolder(folder, file, (handle) => handle.readFile('utf8'));
  return read === 'missing' || read === 'refused' ? null : read;
}

export async function readStampedFileInFolder(
  folder: string,
  file: string
): Promise<{ content: string; modifiedAt: Date } | null> {
  const read = await withFileInFolder(folder, file, async (handle) => ({
    content: await handle.readFile('utf8'),
    modifiedAt: (await handle.stat()).mtime,
  }));
  return read === 'missing' || read === 'refused' ? null : read;
}

function refusedRead(path: readonly string[], message: string): ServiceFolderRead {
  return {
    json: undefined,
    check: { ok: false, problems: [{ severity: 'error', path: formatProblemPath(path), message }] },
  };
}

async function iconProblems(folder: string, icon: string): Promise<string[] | 'refused'> {
  const read = await withFileInFolder(folder, icon, async (handle) => {
    const { size } = await handle.stat();
    if (size > manifestLimits.maxIconBytes)
      return [`icon is ${size} bytes; the limit is ${manifestLimits.maxIconBytes}`];
    return svgIconProblems(await handle.readFile('utf8')).map((problem) => `icon ${problem}`);
  });
  if (read === 'missing') return [`icon file ${icon} not found`];
  return read;
}

export async function readConfinedServiceFolder(folder: string): Promise<ServiceFolderRead> {
  const raw = await withFileInFolder(folder, manifestFileName, (handle) => handle.readFile('utf8'));
  if (raw === 'missing') return refusedRead([], `${manifestFileName} not found in ${folder}`);
  if (raw === 'refused') {
    return refusedRead([], `${manifestFileName} must be a regular file inside the service folder`);
  }
  const bytes = Buffer.byteLength(raw);
  if (bytes > manifestLimits.maxManifestBytes) {
    return refusedRead([], `${manifestFileName} is ${bytes} bytes; the limit is ${manifestLimits.maxManifestBytes}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return refusedRead(
      [],
      `${manifestFileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const check = checkServiceManifest(json);
  const icon = check.manifest?.icon;
  if (icon === undefined) return { json, check };

  const problems = await iconProblems(folder, icon);
  if (problems === 'refused') return refusedRead(['icon'], 'icon must be a regular file inside the service folder');
  const iconCheckProblems: ManifestProblem[] = problems.map((message) => ({
    severity: 'error',
    path: formatProblemPath(['icon']),
    message,
  }));
  return {
    json,
    check: {
      ...check,
      ok: check.ok && iconCheckProblems.length === 0,
      problems: [...check.problems, ...iconCheckProblems],
    },
  };
}

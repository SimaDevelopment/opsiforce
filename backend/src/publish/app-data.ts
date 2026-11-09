import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { restoreOwner, type FileOwner } from '../common/fs';

const APP_DATA = path.join('app', 'data');
const REPLACED_APP_DATA = path.join('.opsiforce', 'replaced-app-data');

export async function holdsAppData(workspace: string): Promise<boolean> {
  const entries = await readdir(path.join(workspace, APP_DATA)).catch(() => []);
  return entries.length > 0;
}

export async function holdsReplacedAppData(workspace: string): Promise<boolean> {
  const owners = await readdir(path.join(workspace, REPLACED_APP_DATA)).catch(() => []);
  return owners.length > 0;
}

export async function replaceAppData(
  sourceWorkspace: string,
  targetWorkspace: string,
  publishJobId: string,
  publishCommitted: (publishJobId: string) => Promise<boolean>
): Promise<void> {
  const target = path.join(targetWorkspace, APP_DATA);
  const replaced = path.join(targetWorkspace, REPLACED_APP_DATA, publishJobId);
  await settleReplacedAppData(targetWorkspace, publishCommitted);
  await mkdir(path.dirname(replaced), { recursive: true });
  if (await exists(target)) await rename(target, replaced);
  else await mkdir(replaced);
  await copyTree(path.join(sourceWorkspace, APP_DATA), target);
}

export async function settleReplacedAppData(
  targetWorkspace: string,
  publishCommitted: (publishJobId: string) => Promise<boolean>
): Promise<void> {
  const owners = await readdir(path.join(targetWorkspace, REPLACED_APP_DATA)).catch(() => []);
  for (const publishJobId of owners) {
    if (await publishCommitted(publishJobId)) {
      await rm(path.join(targetWorkspace, REPLACED_APP_DATA, publishJobId), { recursive: true, force: true });
    } else {
      await restoreReplacedAppData(targetWorkspace, publishJobId);
    }
  }
}

export async function restoreReplacedAppData(targetWorkspace: string, publishJobId: string): Promise<void> {
  const target = path.join(targetWorkspace, APP_DATA);
  const replaced = path.join(targetWorkspace, REPLACED_APP_DATA, publishJobId);
  if (!(await exists(replaced))) return;
  await rm(target, { recursive: true, force: true });
  await rename(replaced, target);
}

export async function discardReplacedAppData(targetWorkspace: string, publishJobId: string): Promise<void> {
  await rm(path.join(targetWorkspace, REPLACED_APP_DATA, publishJobId), { recursive: true, force: true });
}

async function copyTree(source: string, target: string): Promise<void> {
  const stats = await lstat(source);
  const owner: FileOwner = { uid: stats.uid, gid: stats.gid };
  if (stats.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const child of await readdir(source)) {
      await copyTree(path.join(source, child), path.join(target, child));
    }
    await restoreOwner(target, owner);
    await chmod(target, stats.mode);
    return;
  }
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    await restoreOwner(target, owner);
    return;
  }
  if (!stats.isFile()) return;
  await copyFile(source, target);
  await restoreOwner(target, owner);
  await chmod(target, stats.mode);
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false
  );
}

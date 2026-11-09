import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { restoreOwner, type FileOwner } from '../common/fs';

const APP_DATA = path.join('app', 'data');
const REPLACED_APP_DATA = path.join('.opsiforce', 'replaced-app-data');

export async function holdsAppData(workspace: string): Promise<boolean> {
  const entries = await readdir(path.join(workspace, APP_DATA)).catch(() => []);
  return entries.length > 0;
}

export async function replaceAppData(sourceWorkspace: string, targetWorkspace: string): Promise<void> {
  const target = path.join(targetWorkspace, APP_DATA);
  const replaced = path.join(targetWorkspace, REPLACED_APP_DATA);
  await restoreReplacedAppData(targetWorkspace);
  await mkdir(path.dirname(replaced), { recursive: true });
  if (await exists(target)) await rename(target, replaced);
  else await mkdir(replaced);
  await copyTree(path.join(sourceWorkspace, APP_DATA), target);
}

export async function restoreReplacedAppData(targetWorkspace: string): Promise<void> {
  const target = path.join(targetWorkspace, APP_DATA);
  const replaced = path.join(targetWorkspace, REPLACED_APP_DATA);
  if (!(await exists(replaced))) return;
  await rm(target, { recursive: true, force: true });
  await rename(replaced, target);
}

export async function discardReplacedAppData(targetWorkspace: string): Promise<void> {
  await rm(path.join(targetWorkspace, REPLACED_APP_DATA), { recursive: true, force: true });
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

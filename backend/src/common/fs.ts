import crypto from 'crypto';
import path from 'node:path';
import { lchown, mkdir, rename, writeFile } from 'node:fs/promises';

export const EXECUTABLE_FILE_MODE = 0o755;
export const REGULAR_FILE_MODE = 0o644;

export function fileMode(executable: boolean): number {
  return executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE;
}

export interface FileOwner {
  uid: number;
  gid: number;
}

export function isForeignOwner({ uid, gid }: FileOwner): boolean {
  return uid !== process.getuid?.() || gid !== process.getgid?.();
}

export async function restoreOwner(target: string, owner: FileOwner): Promise<void> {
  if (isForeignOwner(owner)) await lchown(target, owner.uid, owner.gid);
}

export async function writeTextAtomic(filePath: string, contents: string | Buffer, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomUUID()}`);
  await writeFile(tmp, contents, mode === undefined ? undefined : { mode });
  await rename(tmp, filePath);
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(data, null, 2));
}

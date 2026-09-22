import crypto from 'crypto';
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';

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

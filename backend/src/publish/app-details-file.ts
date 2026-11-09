import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../common/fs';

const APP_DETAILS_FILE = path.join('app', 'app.meta.json');

export async function keepingAppDetails<T>(workspace: string, change: () => Promise<T>): Promise<T> {
  const file = path.join(workspace, APP_DETAILS_FILE);
  const kept = await readFile(file).catch(() => null);
  const result = await change();
  if (kept) await writeTextAtomic(file, kept);
  return result;
}

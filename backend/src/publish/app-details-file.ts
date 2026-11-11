import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../common/fs';

const APP_DETAILS_FILE = path.join('app', 'app.meta.json');
const KEPT_APP_DETAILS_FILE = path.join('.opsiforce', 'kept-app-details.json');

export async function keepingAppDetails<T>(workspace: string, change: () => Promise<T>): Promise<T> {
  const file = path.join(workspace, APP_DETAILS_FILE);
  const kept = path.join(workspace, KEPT_APP_DETAILS_FILE);
  const keptEarlier = await readFile(kept).catch(() => null);
  if (!keptEarlier) {
    const current = await readFile(file).catch(() => null);
    if (current) await writeTextAtomic(kept, current);
  }
  try {
    return await change();
  } finally {
    const details = await readFile(kept).catch(() => null);
    if (details) {
      await writeTextAtomic(file, details);
      await rm(kept, { force: true });
    }
  }
}

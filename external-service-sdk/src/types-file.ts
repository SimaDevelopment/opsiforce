import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ManifestCheck, ServiceOrigin } from './check-manifest.ts';
import { generateServiceTypes, typesFileName } from './codegen.ts';
import { readServiceFolder } from './service-folder.ts';

export type TypesFileResult = { ok: true; content: string; changed: boolean } | { ok: false; check: ManifestCheck };

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeServiceTypes(folder: string, origin: ServiceOrigin): Promise<TypesFileResult> {
  const read = await readServiceFolder(folder, { origin });
  if (!read.check.ok || !read.check.manifest) return { ok: false, check: read.check };
  const path = join(folder, typesFileName);
  const content = generateServiceTypes(read.json, read.check.manifest);
  const changed = (await readIfPresent(path)) !== content;
  if (changed) await writeFile(path, content);
  return { ok: true, content, changed };
}

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ManifestCheck } from './check-manifest.ts';
import { typesFileName } from './codegen.ts';
import { readServiceFolder } from './service-folder.ts';
import { generateServiceTypes } from './service-types.ts';

export type TypesFileResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; check: Pick<ManifestCheck, 'ok' | 'problems'> };

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function generatedContent(
  folder: string
): Promise<{ content: string } | { check: Pick<ManifestCheck, 'ok' | 'problems'> }> {
  const read = await readServiceFolder(folder);
  if (!read.check.ok || !read.check.manifest) return { check: read.check };
  return { content: generateServiceTypes(read.json, read.check.manifest) };
}

export async function writeServiceTypes(folder: string): Promise<TypesFileResult> {
  const generated = await generatedContent(folder);
  if ('check' in generated) return { ok: false, check: generated.check };
  const path = join(folder, typesFileName);
  const { content } = generated;
  const changed = (await readIfPresent(path)) !== content;
  if (changed) await writeFile(path, content);
  return { ok: true, content, changed };
}

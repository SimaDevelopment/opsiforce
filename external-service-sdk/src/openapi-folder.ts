import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkServiceManifest, type ServiceOrigin } from './check-manifest.ts';
import { formatCheck } from './check-output.ts';
import { generateFromOpenApi } from './openapi-generate.ts';
import { manifestFileName } from './service-folder.ts';
import { writeServiceTypes } from './types-file.ts';

export const routesFileName = 'openapi-routes.json';

export type ServiceFromOpenApiResult = { ok: true; lines: string[] } | { ok: false; output: string };

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function writeWhenChanged(folder: string, name: string, content: string): Promise<string> {
  const path = join(folder, name);
  if ((await readIfPresent(path)) === content) return `${name} is up to date`;
  await writeFile(path, content);
  return `wrote ${name}`;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeServiceFromOpenApi(
  folder: string,
  document: unknown,
  options: { origin: ServiceOrigin }
): Promise<ServiceFromOpenApiResult> {
  const existingText = await readIfPresent(join(folder, manifestFileName));
  const generated = generateFromOpenApi(document, {
    existingManifest: existingText === undefined ? undefined : JSON.parse(existingText),
  });
  if (!generated.ok) {
    return {
      ok: false,
      output: `${generated.problems.map((problem) => `error   ${problem}`).join('\n')}\nnothing written\n`,
    };
  }

  const check = checkServiceManifest(generated.manifest, { origin: options.origin });
  if (!check.ok) return { ok: false, output: formatCheck(check) };

  const lines = [
    await writeWhenChanged(folder, manifestFileName, jsonText(generated.manifest)),
    await writeWhenChanged(folder, routesFileName, jsonText(generated.routes)),
  ];
  const types = await writeServiceTypes(folder, options.origin);
  if (!types.ok) return { ok: false, output: formatCheck(types.check) };
  lines.push(types.changed ? 'wrote service.types.ts' : 'service.types.ts is up to date');
  return { ok: true, lines };
}

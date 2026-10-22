import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type JsonObject = ReturnType<typeof JSON.parse>;

export function fixtureFolder(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export function fixtureManifest(name: string): JsonObject {
  return JSON.parse(readFileSync(join(fixtureFolder(name), 'service.json'), 'utf8'));
}

export function trelloManifest(): JsonObject {
  return fixtureManifest('trello');
}

export function serviceFolderWith(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'external-service-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), content);
  }
  return folder;
}

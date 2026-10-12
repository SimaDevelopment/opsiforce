import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { FIXTURE_SERVICE, fixtureBuiltInsDir } from './app';

export interface EvolvedBuiltIns {
  dir: string;
  remove(): Promise<void>;
}

type ManifestJson = Record<string, unknown> & { operations: Record<string, Record<string, unknown>> };

export async function fixtureCrmEvolved(edit: (manifest: ManifestJson) => void): Promise<EvolvedBuiltIns> {
  const dir = await mkdtemp(join(tmpdir(), 'evolved-built-ins-'));
  const source = join(fixtureBuiltInsDir, FIXTURE_SERVICE);
  const folder = join(dir, FIXTURE_SERVICE);
  await mkdir(folder);
  const manifest = JSON.parse(await readFile(join(source, 'service.json'), 'utf8')) as ManifestJson;
  edit(manifest);
  await writeFile(join(folder, 'service.json'), JSON.stringify(manifest, null, 2));
  await copyFile(join(source, 'icon.svg'), join(folder, 'icon.svg'));
  const echo = '(input) => input';
  await writeFile(
    join(folder, 'handlers.ts'),
    `export default {
  manifestHash: ${JSON.stringify(computeManifestHash(manifest))},
  operations: { ${Object.keys(manifest.operations)
    .map((name) => `${name}: ${echo}`)
    .join(', ')} },
  options: { listAccounts: () => [], listMembers: () => [] },
  info: { connectionStatus: () => ({ text: '' }), accountsSummary: () => ({ text: '' }) },
  buttons: { testMailbox: () => ({ message: '' }), sendInvite: () => ({ message: '' }) },
};
`
  );
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_SERVICE, fixtureBuiltInsDir } from './app';

export interface EvolvedBuiltIns {
  dir: string;
  remove(): Promise<void>;
}

type ManifestJson = Record<string, unknown>;

export async function evolvedBuiltIn(
  sourceDir: string,
  slug: string,
  edit: (manifest: ManifestJson) => void,
  handlers = ''
): Promise<EvolvedBuiltIns> {
  const dir = await mkdtemp(join(__dirname, '.evolved-'));
  const source = join(sourceDir, slug);
  const folder = join(dir, slug);
  await mkdir(folder);
  const manifest = JSON.parse(await readFile(join(source, 'service.json'), 'utf8')) as ManifestJson;
  edit(manifest);
  await writeFile(join(folder, 'service.json'), JSON.stringify(manifest, null, 2));
  if (typeof manifest.icon === 'string') await copyFile(join(source, manifest.icon), join(folder, manifest.icon));
  await writeFile(
    join(folder, 'service.ts'),
    `import { defineService } from '@opsiforce/external-service-sdk';

export default defineService({ manifest: ${JSON.stringify(manifest)}, routes: []${handlers} });
`
  );
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

export function fixtureCrmEvolved(edit: (manifest: ManifestJson) => void): Promise<EvolvedBuiltIns> {
  return evolvedBuiltIn(
    fixtureBuiltInsDir,
    FIXTURE_SERVICE,
    edit,
    `,
  options: { listAccounts: () => [], listMembers: () => [] },
  info: { connectionStatus: () => ({ text: '' }), accountsSummary: () => ({ text: '' }) },
  buttons: { testMailbox: () => ({ message: '' }), sendInvite: () => ({ message: '' }) },
  hooks: {
    onServiceConfigurationSaved: ({ previous, current }) => {
      const control = (globalThis[Symbol.for('opsiforce.test.evolved-hooks')] ??= { fail: false, seen: [] });
      const opened = (values) =>
        values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value?.reveal === 'function' ? value.reveal() : value]));
      control.seen.push({ previous: opened(previous), current: opened(current) });
      if (control.fail) throw new Error('Try later.');
    },
  },`
  );
}

export interface EvolvedHooks {
  fail: boolean;
  seen: { previous: Record<string, unknown> | null; current: Record<string, unknown> | null }[];
}

export function evolvedHooks(): EvolvedHooks {
  return ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.evolved-hooks')] ??= {
    fail: false,
    seen: [],
  }) as EvolvedHooks;
}

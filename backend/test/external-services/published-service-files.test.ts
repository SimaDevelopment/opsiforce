import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublishedServiceFilesReader,
  UnservableServiceFiles,
  type PublishedServiceFiles,
} from '../../src/external-services/registry/published-service-files';
import { BOARDS_MANIFEST, writeServiceFiles } from './support/published-services';
import { writeDevelopmentSkill } from './support/test-lane';

const DIRECTORY = 'projects/boards-production';

const OUTSIDE_SECRET = 'BACKEND_SECRET=do-not-serve';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

describe("a published service's files", () => {
  let storageRoot: string;
  let reader: PublishedServiceFilesReader;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'service-files-'));
    await writeServiceFiles(storageRoot, DIRECTORY, BOARDS_MANIFEST);
    await writeDevelopmentSkill(storageRoot, DIRECTORY, 'Before.\n');
    reader = new PublishedServiceFilesReader({ getOrThrow: () => storageRoot } as unknown as ConfigService);
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('neither caches nor reports a change when a file changes while it is read', async () => {
    const folderReader = reader as unknown as { readFolder(folder: string): Promise<PublishedServiceFiles> };
    const readFolder = folderReader.readFolder.bind(reader);
    vi.spyOn(folderReader, 'readFolder').mockImplementationOnce(async (folder) => {
      const files = await readFolder(folder);
      await writeDevelopmentSkill(storageRoot, DIRECTORY, 'After, written mid-read.\n');
      return files;
    });

    const during = await reader.read(DIRECTORY);
    expect(during).toMatchObject({ changed: false, files: { serviceSkill: 'Before.\n' } });

    const after = await reader.read(DIRECTORY);
    expect(after).toMatchObject({ changed: true, files: { serviceSkill: 'After, written mid-read.\n' } });
    expect((await reader.read(DIRECTORY)).changed).toBe(false);
  });

  describe('refuses files that resolve outside the service folder', () => {
    let outside: string;
    const appFolder = () => join(storageRoot, DIRECTORY, 'app');

    beforeEach(async () => {
      outside = join(storageRoot, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'environ'), OUTSIDE_SECRET);
    });

    it('serves no skill when SKILL.md links out of the folder', async () => {
      await rm(join(appFolder(), 'SKILL.md'));
      await symlink(join(outside, 'environ'), join(appFolder(), 'SKILL.md'));

      const { files } = await reader.read(DIRECTORY);

      expect(files.serviceSkill).toBeNull();
    });

    it('serves no skill when SKILL.md is reached through a linked directory', async () => {
      await rm(join(appFolder(), 'SKILL.md'));
      await writeFile(join(outside, 'SKILL.md'), OUTSIDE_SECRET);
      await symlink(outside, join(appFolder(), 'docs'));
      await symlink('docs/SKILL.md', join(appFolder(), 'SKILL.md'));

      const { files } = await reader.read(DIRECTORY);

      expect(files.serviceSkill).toBeNull();
    });

    it('treats a service.json that links out of the folder as unservable', async () => {
      await rename(join(appFolder(), 'service.json'), join(outside, 'service.json'));
      await symlink(join(outside, 'service.json'), join(appFolder(), 'service.json'));

      await expect(reader.read(DIRECTORY)).rejects.toThrow(UnservableServiceFiles);
    });

    it('treats an icon under a linked directory as unservable', async () => {
      await writeFile(join(outside, 'logo.svg'), ICON);
      await symlink(outside, join(appFolder(), 'assets'));
      await writeServiceFiles(storageRoot, DIRECTORY, { ...BOARDS_MANIFEST, icon: 'assets/logo.svg' });

      await expect(reader.read(DIRECTORY)).rejects.toThrow(/icon must be a regular file inside the service folder/);
    });

    it('treats an app folder that is itself a link as unservable', async () => {
      await rename(appFolder(), join(outside, 'app'));
      await symlink(join(outside, 'app'), appFolder());

      await expect(reader.read(DIRECTORY)).rejects.toThrow(UnservableServiceFiles);
    });
  });
});

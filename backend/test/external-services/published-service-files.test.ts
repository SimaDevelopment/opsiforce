import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublishedServiceFilesReader,
  type PublishedServiceFiles,
} from '../../src/external-services/registry/published-service-files';
import { BOARDS_MANIFEST, writeServiceFiles } from './support/published-services';
import { writeDevelopmentSkill } from './support/test-lane';

const DIRECTORY = 'projects/boards-production';

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
});

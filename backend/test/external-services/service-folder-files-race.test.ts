import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileInFolder } from '../../src/external-services/registry/service-folder-files';

const swaps = vi.hoisted(() => ({ beforeOpen: null as null | (() => Promise<void>) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const swap = swaps.beforeOpen;
      swaps.beforeOpen = null;
      if (swap) await swap();
      return actual.open(...args);
    },
  };
});

const OUTSIDE_SECRET = 'BACKEND_SECRET=do-not-serve';

describe('a service file swapped for a link between the check and the open', () => {
  let root: string;
  let app: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'service-folder-race-'));
    app = join(root, 'app');
    outside = join(root, 'outside');
    await mkdir(join(app, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'SKILL.md'), OUTSIDE_SECRET);
  });

  afterEach(async () => {
    swaps.beforeOpen = null;
    await rm(root, { recursive: true, force: true });
  });

  it('reads nothing when the file itself becomes a link', async () => {
    await writeFile(join(app, 'SKILL.md'), 'Inside.\n');
    swaps.beforeOpen = async () => {
      await rm(join(app, 'SKILL.md'));
      await symlink(join(outside, 'SKILL.md'), join(app, 'SKILL.md'));
    };

    expect(await readFileInFolder(app, 'SKILL.md')).toBeNull();
  });

  it('reads nothing when a parent directory becomes a link', async () => {
    await writeFile(join(app, 'docs', 'SKILL.md'), 'Inside.\n');
    swaps.beforeOpen = async () => {
      await rename(join(app, 'docs'), join(root, 'docs-moved'));
      await symlink(outside, join(app, 'docs'));
    };

    expect(await readFileInFolder(app, 'docs/SKILL.md')).toBeNull();
  });

  it('still reads a regular file that stays in place', async () => {
    await writeFile(join(app, 'SKILL.md'), 'Inside.\n');

    expect(await readFileInFolder(app, 'SKILL.md')).toBe('Inside.\n');
  });
});

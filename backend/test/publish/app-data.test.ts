import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discardReplacedAppData,
  holdsAppData,
  holdsReplacedAppData,
  replaceAppData,
  restoreReplacedAppData,
  settleReplacedAppData,
} from '../../src/publish/app-data';
import { keepingAppDetails } from '../../src/publish/app-details-file';

describe('Publish with data', () => {
  let root: string;
  let development: string;
  let production: string;
  const donePublishes = new Set<string>();
  const publishCommitted = async (publishJobId: string) => donePublishes.has(publishJobId);
  const publishWithData = (publishJobId: string) =>
    replaceAppData(development, production, publishJobId, publishCommitted);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'app-data-'));
    development = path.join(root, 'development');
    production = path.join(root, 'production');
    await writeData(development, { 'app.db': 'development rows', 'uploads/roster.csv': 'Ada' });
    await writeData(production, { 'app.db': 'production rows', 'app.db-journal': 'production journal' });
  });

  afterEach(async () => {
    donePublishes.clear();
    await rm(root, { recursive: true, force: true });
  });

  it("leaves the target holding exactly Development's App data, none of its own", async () => {
    await publishWithData('publish-1');

    expect(await listData(production)).toEqual(['app.db', 'uploads', 'uploads/roster.csv']);
    expect(await readData(production, 'app.db')).toBe('development rows');
  });

  it("keeps each copied file's mode", async () => {
    await writeData(development, { 'run.sh': '#!/bin/sh' }, 0o750);

    await publishWithData('publish-1');

    expect((await stat(path.join(production, 'app', 'data', 'run.sh'))).mode & 0o777).toBe(0o750);
  });

  it('gives the target its own data back when the Publish fails', async () => {
    await publishWithData('publish-1');

    await restoreReplacedAppData(production, 'publish-1');

    expect(await listData(production)).toEqual(['app.db', 'app.db-journal']);
    expect(await readData(production, 'app.db')).toBe('production rows');
  });

  it('leaves a first-published target empty again when that Publish fails', async () => {
    await rm(path.join(production, 'app', 'data'), { recursive: true });
    await publishWithData('publish-1');

    await restoreReplacedAppData(production, 'publish-1');

    expect(await holdsAppData(production)).toBe(false);
  });

  it('gives a target whose failed Publish never restored its data back that data before copying again', async () => {
    await publishWithData('publish-1');
    await writeData(development, { 'app.db': 'newer development rows' });

    await publishWithData('publish-2');
    await restoreReplacedAppData(production, 'publish-2');

    expect(await readData(production, 'app.db')).toBe('production rows');
  });

  it('never brings back the data a finished Publish replaced', async () => {
    await publishWithData('publish-1');
    donePublishes.add('publish-1');
    await writeData(production, { 'app.db': 'rows written after the Publish' });

    await settleReplacedAppData(production, publishCommitted);
    await publishWithData('publish-2');
    await restoreReplacedAppData(production, 'publish-2');

    expect(await readData(production, 'app.db')).toBe('rows written after the Publish');
  });

  it('gives a target stranded by a restart mid-Publish its own data back', async () => {
    await publishWithData('publish-1');

    await settleReplacedAppData(production, publishCommitted);

    expect(await readData(production, 'app.db')).toBe('production rows');
  });

  it('shows data a failed rollback left moved aside until it is settled', async () => {
    await publishWithData('publish-1');

    expect(await holdsReplacedAppData(production)).toBe(true);
    await settleReplacedAppData(production, publishCommitted);

    expect(await holdsReplacedAppData(production)).toBe(false);
    expect(await readData(production, 'app.db')).toBe('production rows');
  });

  it('leaves the target alone when there is nothing to restore', async () => {
    await restoreReplacedAppData(production, 'publish-1');
    await settleReplacedAppData(production, publishCommitted);

    expect(await readData(production, 'app.db')).toBe('production rows');
  });

  it('keeps the copied data once the replaced data is discarded', async () => {
    await publishWithData('publish-1');

    await discardReplacedAppData(production, 'publish-1');
    await restoreReplacedAppData(production, 'publish-1');

    expect(await readData(production, 'app.db')).toBe('development rows');
  });

  it('finds no App data in an empty or missing data folder', async () => {
    const empty = path.join(root, 'empty');
    await mkdir(path.join(empty, 'app', 'data'), { recursive: true });

    expect(await holdsAppData(empty)).toBe(false);
    expect(await holdsAppData(path.join(root, 'missing'))).toBe(false);
    expect(await holdsAppData(development)).toBe(true);
  });
});

describe("A target's App Details", () => {
  it('survive a change that rewrites the workspace, such as a git reset', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'app-details-'));
    const file = path.join(workspace, 'app', 'app.meta.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"name":"Book Club"}');

    await keepingAppDetails(workspace, () => writeFile(file, '{"name":"Book Club Tracker"}'));

    expect(await readFile(file, 'utf8')).toBe('{"name":"Book Club"}');
    await rm(workspace, { recursive: true, force: true });
  });

  it('survive a restart between the reset and putting them back', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'app-details-'));
    const file = path.join(workspace, 'app', 'app.meta.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"name":"Book Club"}');
    const resetToDevelopment = () => writeFile(file, '{"name":"Book Club Tracker"}');

    void keepingAppDetails(workspace, async () => {
      await resetToDevelopment();
      await new Promise(() => undefined);
    });
    await expect.poll(() => readFile(file, 'utf8')).toBe('{"name":"Book Club Tracker"}');
    await keepingAppDetails(workspace, resetToDevelopment);

    expect(await readFile(file, 'utf8')).toBe('{"name":"Book Club"}');
    await rm(workspace, { recursive: true, force: true });
  });
});

async function writeData(workspace: string, files: Record<string, string>, mode?: number): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(workspace, 'app', 'data', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, mode === undefined ? undefined : { mode });
  }
}

function readData(workspace: string, name: string): Promise<string> {
  return readFile(path.join(workspace, 'app', 'data', name), 'utf8');
}

async function listData(workspace: string): Promise<string[]> {
  const entries = await readdir(path.join(workspace, 'app', 'data'), { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join('/')).toSorted();
}

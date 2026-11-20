import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/git/git.service';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example-org.test', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('Committing a working tree', () => {
  const gitService = new GitService();
  let workspace: string;

  const committedPaths = () => git(workspace, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
  const write = async (relPath: string, content: string) => {
    await mkdir(path.dirname(path.join(workspace, relPath)), { recursive: true });
    await writeFile(path.join(workspace, relPath), content);
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'working-tree-'));
    git(workspace, 'init', '-q');
    await write('app/startup.sh', '#!/bin/bash\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('commits every file git does not ignore', async () => {
    await write('app/.gitignore', '/data/\n');
    await write('app/data/app.db', 'rows');

    await gitService.commitWorkingTree(workspace, 'Publish');

    expect(committedPaths()).toEqual(['app/.gitignore', 'app/startup.sh']);
  });

  it('refuses a folder that holds its own git repository, naming it, and commits nothing', async () => {
    git(path.join(workspace, 'app'), 'init', '-q');
    git(path.join(workspace, 'app'), 'add', '-A');
    git(path.join(workspace, 'app'), 'commit', '-q', '-m', 'cloned');

    await expect(gitService.commitWorkingTree(workspace, 'Publish')).rejects.toMatchObject({
      response: { code: 'nested-git-repository' },
      message: expect.stringContaining('"app" holds its own git repository'),
    });
    expect(() => git(workspace, 'rev-parse', '--verify', 'HEAD')).toThrow();
  });

  it('commits the files on the next try, once the refused git repository is moved into an ignored folder', async () => {
    await write('app/.gitignore', '/data/\n');
    git(path.join(workspace, 'app'), 'init', '-q');
    git(path.join(workspace, 'app'), 'add', '-A');
    git(path.join(workspace, 'app'), 'commit', '-q', '-m', 'cloned');
    await expect(gitService.commitWorkingTree(workspace, 'Publish')).rejects.toMatchObject({
      response: { code: 'nested-git-repository' },
    });

    await mkdir(path.join(workspace, 'app/data'));
    await rename(path.join(workspace, 'app/.git'), path.join(workspace, 'app/data/source.git'));
    await gitService.commitWorkingTree(workspace, 'Publish');

    expect(committedPaths()).toEqual(['app/.gitignore', 'app/startup.sh']);
  });

  it('refuses a nested git repository that has no commit yet', async () => {
    git(path.join(workspace, 'app'), 'init', '-q');

    await expect(gitService.commitWorkingTree(workspace, 'Publish')).rejects.toMatchObject({
      response: { code: 'nested-git-repository' },
      message: expect.stringContaining('"app"'),
    });
  });

  it('commits the files of a clone whose git data sits in an ignored folder', async () => {
    await write('app/.gitignore', '/data/\n');
    git(workspace, 'init', '-q', '--bare', 'app/data/source.git');

    await gitService.commitWorkingTree(workspace, 'Publish');

    expect(committedPaths()).toEqual(['app/.gitignore', 'app/startup.sh']);
  });
});

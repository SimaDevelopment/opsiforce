import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import archiver from 'archiver';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_NAME } from '../src/agent/agent.types';
import { ProjectExportProcessor } from '../src/export/project-export.processor';
import { ProjectExportService } from '../src/export/project-export.service';
import { ProjectExportStatus, type ProjectExportJobData } from '../src/export/project-export.types';
import { GitService } from '../src/git/git.service';
import { ProjectFilesService } from '../src/project/project-files.service';
import { ensureBuiltInAgent } from './support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { FakeQueue } from './support/infra-fakes';
import { createTenantRow, createUserRow } from './support/org-fixtures';

let harness: DomainTestHarness;
let tenantId: string;
let scratch: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  tenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  scratch = await mkdtemp(path.join(tmpdir(), 'export-import-'));
});

afterAll(async () => {
  await harness.close();
  await rm(scratch, { recursive: true, force: true });
});

function git(workspace: string, ...args: string[]): void {
  execFileSync('git', ['-C', workspace, '-c', 'user.email=pod@test', '-c', 'user.name=Pod', ...args], {
    stdio: 'ignore',
  });
}

async function exportProject(prepare: (workspace: string) => Promise<void>): Promise<string> {
  const config = harness.moduleRef.get(ConfigService);
  const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
  const projectId = (await harness.projects.create({ agentId }, tenantId, { createdBy: await createUserRow() })).id;
  const workspace = path.join(
    config.getOrThrow<string>('storageMountPath'),
    (await harness.projects.findOneById(projectId)).directory
  );
  await writeFile(path.join(workspace, '.gitignore'), 'data/\nnode_modules/\n');
  git(workspace, 'init', '-q');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  await prepare(workspace);

  const events = harness.fakes.projectEvents as never;
  const exports = new ProjectExportService(config, events, new FakeQueue() as never);
  const processor = new ProjectExportProcessor(
    config,
    harness.projects,
    events,
    harness.moduleRef.get(ProjectFilesService),
    harness.moduleRef.get(GitService),
    harness.agents,
    exports
  );
  const { id } = await exports.startExport(projectId, tenantId);
  await processor.process({ data: { exportJobId: id, projectId, tenantId } } as Job<ProjectExportJobData>);
  expect((await exports.getJob(id)).status).toBe(ProjectExportStatus.Completed);
  return exports.artifactPath(id);
}

async function importInto(archive: string): Promise<string> {
  const target = await mkdtemp(path.join(scratch, 'imported-'));
  await harness.projectImports.unpack(archive, target, async () => {});
  return target;
}

type HandmadeEntry = { name: string; content?: string; symlinkTo?: string };

async function zipOf(entries: HandmadeEntry[]): Promise<string> {
  const target = path.join(scratch, `handmade-${entries.length}-${Date.now()}.zip`);
  const output = createWriteStream(target);
  const archive = archiver('zip');
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify({ kind: 'project' }), { name: 'manifest.json' });
  for (const { name, content, symlinkTo } of entries) {
    if (symlinkTo !== undefined) archive.symlink(name, symlinkTo);
    else archive.append(content ?? Buffer.alloc(0), { name });
  }
  await archive.finalize();
  await closed;
  return target;
}

const modeOf = async (target: string) => (await stat(target)).mode & 0o777;

describe('Project Export and Import', () => {
  it('bring back empty directories and directory modes, as a database data folder needs', async () => {
    const archive = await exportProject(async (workspace) => {
      const data = path.join(workspace, 'app/data/postgres');
      await mkdir(path.join(data, 'pg_tblspc'), { recursive: true });
      await mkdir(path.join(data, 'pg_logical/snapshots'), { recursive: true });
      await writeFile(path.join(data, 'PG_VERSION'), '17\n');
      await chmod(data, 0o700);
    });

    const imported = path.join(await importInto(archive), 'app/data/postgres');

    expect((await stat(path.join(imported, 'pg_tblspc'))).isDirectory()).toBe(true);
    expect((await stat(path.join(imported, 'pg_logical/snapshots'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(imported, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(await modeOf(imported)).toBe(0o700);
  });

  it('still import an archive made before directories were recorded', async () => {
    const archive = await zipOf([{ name: 'workspace/app/notes/today.txt', content: 'kept' }]);

    const imported = await importInto(archive);

    expect(await readFile(path.join(imported, 'app/notes/today.txt'), 'utf8')).toBe('kept');
  });

  it('refuse a directory entry whose path leaves the Project', async () => {
    const archive = await zipOf([{ name: 'workspace/../escaped/' }]);

    await expect(importInto(archive)).rejects.toThrow();
    expect(existsSync(path.join(scratch, 'escaped'))).toBe(false);
  });

  it('round-trip files, modes and symlinks that stay inside the Project', async () => {
    const archive = await exportProject(async (workspace) => {
      const modules = path.join(workspace, 'app/node_modules');
      await mkdir(path.join(modules, 'tool'), { recursive: true });
      await mkdir(path.join(modules, '.bin'));
      await writeFile(path.join(modules, 'tool/cli.js'), 'run\n');
      await chmod(path.join(modules, 'tool/cli.js'), 0o755);
      await symlink('../tool/cli.js', path.join(modules, '.bin/tool'));
      await writeFile(path.join(workspace, 'app/notes.md'), 'kept\n');
      await symlink('notes.md', path.join(workspace, 'app/latest.md'));
    });

    const imported = await importInto(archive);

    expect(await readlink(path.join(imported, 'app/latest.md'))).toBe('notes.md');
    expect(await readFile(path.join(imported, 'app/latest.md'), 'utf8')).toBe('kept\n');
    const tool = path.join(imported, 'app/node_modules/.bin/tool');
    expect(await readlink(tool)).toBe('../tool/cli.js');
    expect(await readFile(tool, 'utf8')).toBe('run\n');
    expect(await modeOf(tool)).toBe(0o755);
  });

  it('refuse a chain of symlinks that each look confined but lead out of the Project, writing nothing outside it', async () => {
    const archive = await zipOf([
      { name: 'workspace/sub/up', symlinkTo: '..' },
      { name: 'workspace/sub/up/out', symlinkTo: '..' },
      { name: 'workspace/sub/up/out/chained', content: 'escaped' },
    ]);

    await expect(importInto(archive)).rejects.toThrow(/unsafe/);
    expect(existsSync(path.join(scratch, 'chained'))).toBe(false);
  });

  it.each<{ kind: string; entries: HandmadeEntry[] }>([
    {
      kind: 'a file under a symlink',
      entries: [
        { name: 'workspace/sub/' },
        { name: 'workspace/link', symlinkTo: 'sub' },
        { name: 'workspace/link/notes.md', content: 'through' },
      ],
    },
    {
      kind: 'a directory under a symlink',
      entries: [
        { name: 'workspace/sub/' },
        { name: 'workspace/link', symlinkTo: 'sub' },
        { name: 'workspace/link/made/' },
      ],
    },
    {
      kind: 'a file in place of a symlink',
      entries: [
        { name: 'workspace/notes.md', content: 'kept' },
        { name: 'workspace/link', symlinkTo: 'notes.md' },
        { name: 'workspace/link', content: 'over' },
      ],
    },
  ])('refuse $kind, even one that stays inside the Project', async ({ entries }) => {
    await expect(importInto(await zipOf(entries))).rejects.toThrow(/unsafe/);
  });

  it('refuse an entry whose path climbs out with ../, writing nothing outside the Project', async () => {
    const archive = await zipOf([{ name: 'workspace/../plain', content: 'escaped' }]);

    await expect(importInto(archive)).rejects.toThrow();
    expect(existsSync(path.join(scratch, 'plain'))).toBe(false);
  });
});

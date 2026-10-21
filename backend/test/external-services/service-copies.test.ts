import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import archiver from 'archiver';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { externalServiceConfigs, projectEnvironments, projects } from '../../db/schema';
import { AgentImportService } from '../../src/agent/agent-import.service';
import { ProjectImportService } from '../../src/project/project-import.service';
import { ProjectImportUploadController } from '../../src/project/project-import-upload.controller';
import { ProjectImportUploadService } from '../../src/project/project-import-upload.service';
import { ProjectService } from '../../src/project/project.service';
import { packSkill, unpackSkill, type SkillTree } from '../../src/store/gate';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  createCustomService,
  ensureExternalServiceBuilder,
  TENANT_SERVICES,
  type CreatedCustomService,
} from './support/custom-services';
import { builtInServiceId, memberWithout, tenantAdmin, type PersonFixture } from './support/fixtures';
import { BOARDS_MANIFEST, productionEnvironmentOf } from './support/published-services';
import { publishReview, publishService } from './support/service-publishing';
import { storeServiceConfigurationRaw } from './support/test-lane';

const run = promisify(execFile);
const AWS_KEY = 'AKIAA1B2C3D4E5F6G7H8';
const SDK_TARBALL = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);

@Module({ controllers: [ProjectImportUploadController] })
class UploadRoutesModule {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
let storageRoot: string;
let admin: PersonFixture;
let elsewhere: PersonFixture;

beforeAll(async () => {
  await ensureExternalServiceBuilder();
  storageRoot = await mkdtemp(join(tmpdir(), 'service-copies-'));
  harness = await createExternalServicesTestApp({
    env: { STORAGE_MOUNT_PATH: storageRoot },
    extraModules: [UploadRoutesModule],
  });
  app = harness.app;
  admin = await tenantAdmin(app);
  elsewhere = await tenantAdmin(app);
});

afterAll(async () => {
  await harness.close();
  await rm(storageRoot, { recursive: true, force: true });
});

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 6)}`;
}

function git(workspace: string, args: string[]) {
  return run('git', ['-c', 'user.email=builder@test.local', '-c', 'user.name=Builder', ...args], { cwd: workspace });
}

async function developmentDirectory(builderChatId: string): Promise<string> {
  const [row] = await db
    .select({ directory: projectEnvironments.directory })
    .from(projectEnvironments)
    .where(and(eq(projectEnvironments.projectId, builderChatId), eq(projectEnvironments.isDefault, true)));
  if (!row) throw new Error(`Builder chat ${builderChatId} has no Development`);
  return join(storageRoot, row.directory);
}

function packageJson(sdkVersion: string): string {
  return JSON.stringify({
    name: 'opsiforce-external-service',
    dependencies: { '@opsiforce/external-service-sdk': `file:./vendor/external-service-sdk-${sdkVersion}.tgz` },
  });
}

function serviceFiles(sdkVersion = '2.0.0'): Record<string, string | Buffer> {
  return {
    'service.json': JSON.stringify(BOARDS_MANIFEST, null, 2),
    'package.json': packageJson(sdkVersion),
    'yarn.lock': '# lockfile\n',
    'service.ts': 'export default {};\n',
    'src/client.ts': 'export const base = "https://boards.example";\n',
    'SKILL.md': '# Boards\n',
    'test/groups/cards.test.ts': 'test("works", () => {});\n',
    'startup.sh': '#!/bin/bash\nexec yarn dev\n',
    [`vendor/external-service-sdk-${sdkVersion}.tgz`]: SDK_TARBALL,
  };
}

const JUNK = {
  '.yarn/cache/left-pad.zip': 'cached',
  '.yarn/install-state.gz': 'state',
  '.pnp.cjs': 'pnp',
  'node_modules/left-pad/index.js': 'module',
  '._service.ts': 'resource fork',
};

async function writeApp(workspace: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, 'app', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    if (path.endsWith('.sh')) await chmod(target, 0o755);
  }
}

interface SourceService extends CreatedCustomService {
  workspace: string;
}

async function sourceService(person: PersonFixture = admin, sdkVersion = '2.0.0'): Promise<SourceService> {
  const service = await createCustomService(app, person, 'Boards', uniqueSlug('boards'));
  const workspace = await developmentDirectory(service.builderChatId);
  await writeApp(workspace, serviceFiles(sdkVersion));
  await writeFile(join(workspace, '.gitignore'), '.cache/\n');
  await git(workspace, ['init', '-q']);
  await git(workspace, ['add', '-A']);
  await writeApp(workspace, JUNK);
  await git(workspace, ['add', '-f', '--', ...Object.keys(JUNK).map((path) => `app/${path}`)]);
  await git(workspace, ['commit', '-q', '-m', 'Boards']);
  await writeFile(join(workspace, 'app', 'service.ts'), 'export default { uncommitted: true };\n');
  await writeFile(join(workspace, 'app', 'draft.ts'), 'export const draft = 1;\n');
  return { ...service, workspace };
}

function exportRoute(person: PersonFixture, id: string, suffix = '') {
  return app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${id}/export${suffix}`, headers: person.headers });
}

function duplicateRoute(person: PersonFixture, id: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `${TENANT_SERVICES}/${id}/duplicate`,
    headers: person.headers,
    payload: payload as object,
  });
}

function importRoute(person: PersonFixture, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `${TENANT_SERVICES}/import`,
    headers: person.headers,
    payload: payload as object,
  });
}

async function exportOf(service: CreatedCustomService, person: PersonFixture = admin): Promise<Buffer> {
  const res = await exportRoute(person, service.id);
  if (res.statusCode !== 200) throw new Error(`Export answered ${res.statusCode}: ${res.body}`);
  return res.rawPayload;
}

async function upload(person: PersonFixture, archive: Buffer): Promise<string> {
  const uploads = app.get(ProjectImportUploadService);
  const { uploadId } = await uploads.createSession(person.tenant.tenantId, archive.byteLength);
  await uploads.writeChunk({
    tenantId: person.tenant.tenantId,
    uploadId,
    index: '0',
    digestHeader: createHash('sha256').update(archive).digest('hex'),
    contentLengthHeader: String(archive.byteLength),
    body: Readable.from([archive]),
  });
  return uploadId;
}

function treeFiles(tree: SkillTree, prefix: string): Record<string, string> {
  return Object.fromEntries(
    tree
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => [file.path.slice(prefix.length), file.content.toString('base64')])
  );
}

function encoded(files: Record<string, string | Buffer>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, Buffer.from(content).toString('base64')])
  );
}

async function manifestOf(archive: Buffer): Promise<Record<string, unknown>> {
  const tree = await unpackSkill(archive);
  const manifest = tree.find((file) => file.path === 'manifest.json');
  if (!manifest) throw new Error('expected manifest.json');
  return JSON.parse(manifest.content.toString('utf8')) as Record<string, unknown>;
}

async function rewriteManifest(archive: Buffer, change: (manifest: Record<string, unknown>) => void): Promise<Buffer> {
  const tree = await unpackSkill(archive);
  return packSkill(
    tree.map((file) => {
      if (file.path !== 'manifest.json') return file;
      const manifest = JSON.parse(file.content.toString('utf8')) as Record<string, unknown>;
      change(manifest);
      return { path: file.path, executable: file.executable, content: Buffer.from(JSON.stringify(manifest)) };
    })
  );
}

async function withExtraEntries(
  archive: Buffer,
  extra: { name: string; content?: string; symlinkTo?: string }[]
): Promise<Buffer> {
  const tree = await unpackSkill(archive);
  return new Promise((resolve, reject) => {
    const zip = archiver('zip');
    const chunks: Buffer[] = [];
    zip.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.on('error', reject);
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    for (const file of tree) zip.append(file.content, { name: file.path, mode: file.executable ? 0o755 : 0o644 });
    for (const entry of extra) {
      if (entry.symlinkTo) zip.symlink(entry.name, entry.symlinkTo);
      else zip.append(entry.content ?? '', { name: entry.name });
    }
    void zip.finalize();
  });
}

async function seededFiles(builderChatId: string): Promise<Record<string, string>> {
  const workspace = await developmentDirectory(builderChatId);
  const listed = await run('find', ['.', '-type', 'f'], { cwd: join(workspace, 'app') });
  const paths = listed.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(2));
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, (await readFile(join(workspace, 'app', path))).toString('base64')] as const)
    )
  );
}

async function initialCommitMessageOf(builderChatId: string): Promise<string> {
  return readFile(join(await developmentDirectory(builderChatId), '.opsiforce', 'initial-commit-message'), 'utf8');
}

async function configurationRowsOf(serviceId: string) {
  return db.select().from(externalServiceConfigs).where(eq(externalServiceConfigs.externalServiceId, serviceId));
}

describe('exporting a custom External Service', () => {
  it("downloads <slug>-service-export.zip with a stamped manifest and Development's committed app/, without junk or uncommitted work", async () => {
    const source = await sourceService();

    const res = await exportRoute(admin, source.id);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toContain(`${source.slug}-service-export.zip`);
    const tree = await unpackSkill(res.rawPayload);
    expect(tree.map((file) => file.path).filter((path) => !path.startsWith('app/'))).toEqual(['manifest.json']);
    expect(treeFiles(tree, 'app/')).toEqual(encoded(serviceFiles()));
    expect(tree.find((file) => file.path === 'app/startup.sh')?.executable).toBe(true);
    expect(await manifestOf(res.rawPayload)).toEqual({
      kind: 'external-service',
      stamp: {
        exportFormatVersion: 1,
        platformVersion: expect.any(String),
        agentImageVersion: expect.any(String),
        arch: expect.any(String),
        sdkVersion: '2.0.0',
      },
      service: { name: 'Boards', slug: source.slug },
    });
  });

  it('refuses a service whose builder has committed nothing yet', async () => {
    const service = await createCustomService(app, admin, 'Empty', uniqueSlug('empty'));

    const res = await exportRoute(admin, service.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'nothing-committed' });
  });

  it('offers nothing for a built-in or for another Organization’s service', async () => {
    const source = await sourceService();

    expect((await exportRoute(admin, await builtInServiceId(FIXTURE_SERVICE))).statusCode).toBe(404);
    expect((await exportRoute(elsewhere, source.id)).statusCode).toBe(404);
    expect(
      (await duplicateRoute(admin, await builtInServiceId(FIXTURE_SERVICE), { name: 'X', slug: uniqueSlug('x') }))
        .statusCode
    ).toBe(404);
  });
});

describe('committed links in app/', () => {
  it('are left out of an export and a duplicate, never followed', async () => {
    const source = await sourceService();
    const outside = join(storageRoot, `outside-${randomUUID().slice(0, 6)}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'environ'), 'BACKEND_SECRET=do-not-copy');
    await symlink(join(outside, 'environ'), join(source.workspace, 'app', 'notes.md'));
    await symlink(outside, join(source.workspace, 'app', 'docs'));
    await git(source.workspace, ['add', 'app/notes.md', 'app/docs']);
    await git(source.workspace, ['commit', '-q', '-m', 'links']);

    const exported = await exportRoute(admin, source.id);
    const duplicated = await duplicateRoute(admin, source.id, { name: 'Linked', slug: uniqueSlug('linked') });

    expect(exported.statusCode, exported.body).toBe(200);
    expect(treeFiles(await unpackSkill(exported.rawPayload), 'app/')).toEqual(encoded(serviceFiles()));
    expect(duplicated.statusCode, duplicated.body).toBe(201);
    const copy = duplicated.json<{ service: CreatedCustomService }>().service;
    const copyApp = join(await developmentDirectory(copy.builderChatId), 'app');
    expect((await run('find', ['.', '-type', 'l'], { cwd: copyApp })).stdout).toBe('');
    expect(await seededFiles(copy.builderChatId)).toEqual(encoded(serviceFiles()));
  });
});

describe('the export preview', () => {
  it('lists key-like text in the committed files as a warning and still downloads', async () => {
    const source = await sourceService();
    await writeFile(join(source.workspace, 'app', 'src', 'client.ts'), `export const key = '${AWS_KEY}';\n`);
    await git(source.workspace, ['commit', '-q', '-am', 'key']);

    const res = await exportRoute(admin, source.id, '/preview');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hits: [{ path: 'src/client.ts', reason: expect.stringContaining('line 1') }] });
    expect((await exportRoute(admin, source.id)).statusCode).toBe(200);
  });

  it('is empty for a clean service', async () => {
    const source = await sourceService();

    expect((await exportRoute(admin, source.id, '/preview')).json()).toEqual({ hits: [] });
  });
});

describe('duplicating a custom External Service', () => {
  it("creates a new Draft with its own builder chat holding the source's committed app/, and no configuration of any kind", async () => {
    const source = await sourceService();
    await storeServiceConfigurationRaw(source.id, admin.tenant.tenantId, 'development', { apiToken: 'dev' });
    await storeServiceConfigurationRaw(source.id, admin.tenant.tenantId, null, { apiToken: 'live' });
    const slug = uniqueSlug('boards-copy');

    const res = await duplicateRoute(admin, source.id, { name: 'Boards (copy)', slug });

    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<{ service: CreatedCustomService; warnings: string[] }>();
    expect(copy.service).toMatchObject({ slug, displayName: 'Boards (copy)', origin: 'custom', published: false });
    expect(copy.service.builderChatId).not.toBe(source.builderChatId);
    expect(copy.warnings).toEqual([]);
    expect(await seededFiles(copy.service.builderChatId)).toEqual(encoded(serviceFiles()));
    expect(await initialCommitMessageOf(copy.service.builderChatId)).toBe('Copied from Boards\n');
    expect(await configurationRowsOf(copy.service.id)).toEqual([]);
    const [chat] = await db.select().from(projects).where(eq(projects.id, copy.service.builderChatId));
    expect(chat).toMatchObject({ kind: 'external_service_builder_chat', title: 'Boards (copy)' });
  });

  it('replaces the template a pre-warmed workspace already laid and commits the copy as one commit', async () => {
    const source = await sourceService();
    const projectService = app.get(ProjectService);
    const create = projectService.create.bind(projectService);
    let warmWorkspace = '';
    vi.spyOn(projectService, 'create').mockImplementationOnce((dto, tenantId, context = {}) =>
      create(dto, tenantId, {
        ...context,
        configureBeforeDelivery: async (projectEnvironmentId) => {
          const [env] = await db
            .select({ directory: projectEnvironments.directory })
            .from(projectEnvironments)
            .where(eq(projectEnvironments.id, projectEnvironmentId));
          warmWorkspace = join(storageRoot, env.directory);
          await writeApp(warmWorkspace, { 'service.json': '{}', 'template-only.ts': 'x\n' });
          await writeApp(warmWorkspace, { '.yarn/cache/template.zip': 'kept' });
          await writeFile(join(warmWorkspace, '.gitignore'), '.opencode/\n**/.yarn/cache\n');
          await git(warmWorkspace, ['init', '-q']);
          await git(warmWorkspace, ['add', '-A']);
          await git(warmWorkspace, ['commit', '-q', '-m', 'Initial template']);
          await context.configureBeforeDelivery?.(projectEnvironmentId);
        },
      })
    );

    const res = await duplicateRoute(admin, source.id, { name: 'Warm copy', slug: uniqueSlug('warm') });

    expect(res.statusCode, res.body).toBe(201);
    const log = (await git(warmWorkspace, ['log', '--format=%s'])).stdout.trim().split('\n');
    expect(log).toEqual(['Copied from Boards', 'Initial template']);
    expect((await git(warmWorkspace, ['status', '--porcelain'])).stdout.trim()).toBe('');
    const committed = (await git(warmWorkspace, ['ls-files', 'app'])).stdout.trim().split('\n').toSorted();
    expect(committed).toEqual(
      Object.keys(serviceFiles())
        .map((path) => `app/${path}`)
        .toSorted()
    );
    expect(existsSync(join(warmWorkspace, 'app', '.yarn', 'cache', 'template.zip'))).toBe(true);
    expect((await stat(join(warmWorkspace, 'app', 'startup.sh'))).mode & 0o111).not.toBe(0);
  });

  it('answers a taken slug with a conflict, and an invalid one with a refusal', async () => {
    const source = await sourceService();

    const taken = await duplicateRoute(admin, source.id, { name: 'Again', slug: source.slug });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'slug-taken' });

    const reserved = await duplicateRoute(admin, source.id, { name: 'Again', slug: FIXTURE_SERVICE });
    expect(reserved.statusCode).toBe(409);

    const invalid = await duplicateRoute(admin, source.id, { name: 'Again', slug: '1bad' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid-slug' });
  });

  it('gives a copy whose Development the Publish dialog checks like any Draft', async () => {
    const source = await sourceService();
    const copy = (await duplicateRoute(admin, source.id, { name: 'Publishable', slug: uniqueSlug('pub') })).json<{
      service: CreatedCustomService;
    }>();

    const review = await publishReview(
      app,
      admin,
      copy.service.id,
      await productionEnvironmentOf(admin.tenant.tenantId)
    );

    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().check.ok).toBe(true);
  });
});

describe('importing a service export', () => {
  it('creates a new Draft in another Organization with the files written, named from the file unless asked otherwise', async () => {
    const source = await sourceService();
    const archive = await exportOf(source);

    const res = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, archive),
      fileName: 'boards-service-export (1).zip',
    });

    expect(res.statusCode, res.body).toBe(201);
    const imported = res.json<{ service: CreatedCustomService; warnings: string[] }>();
    expect(imported.service).toMatchObject({ slug: source.slug, displayName: 'Boards', published: false });
    expect(imported.warnings).toEqual([]);
    expect(await seededFiles(imported.service.builderChatId)).toEqual(encoded(serviceFiles()));
    expect(await initialCommitMessageOf(imported.service.builderChatId)).toBe(
      'Imported from boards-service-export (1).zip\n'
    );

    const renamed = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, archive),
      name: 'Boards two',
      slug: uniqueSlug('boards-two'),
    });
    expect(renamed.statusCode, renamed.body).toBe(201);
    expect(renamed.json().service.displayName).toBe('Boards two');
  });

  it('answers a taken slug with a conflict carrying the file’s name and slug, and imports a resubmission of the same upload', async () => {
    const source = await sourceService();
    const uploadId = await upload(admin, await exportOf(source));

    const taken = await importRoute(admin, { uploadId });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'slug-taken', nameFromFile: 'Boards', slugFromFile: source.slug });

    const retried = await importRoute(admin, { uploadId, name: 'Boards', slug: uniqueSlug('boards-retry') });
    expect(retried.statusCode, retried.body).toBe(201);
  });

  it('refuses a name or slug that is not text', async () => {
    const uploadId = await upload(admin, await exportOf(await sourceService()));

    const badName = await importRoute(admin, { uploadId, name: ['Boards'], slug: uniqueSlug('boards-list') });
    expect(badName.statusCode).toBe(400);
    expect(badName.json()).toMatchObject({ code: 'invalid-name' });

    const badSlug = await importRoute(admin, { uploadId, name: 'Boards', slug: { slug: 'boards' } });
    expect(badSlug.statusCode).toBe(400);
    expect(badSlug.json()).toMatchObject({ code: 'invalid-slug' });
  });

  it('skips junk entries and refuses a symlink or a path outside app/, writing nothing', async () => {
    const source = await sourceService();
    const archive = await exportOf(source);

    const junky = await withExtraEntries(archive, [
      { name: '__MACOSX/app/._service.json', content: 'fork' },
      { name: 'app/._service.ts', content: 'fork' },
      { name: 'app/node_modules/x/index.js', content: 'x' },
      { name: 'notes.txt', content: 'outside app' },
    ]);
    const res = await importRoute(elsewhere, { uploadId: await upload(elsewhere, junky), slug: uniqueSlug('junky') });
    expect(res.statusCode, res.body).toBe(201);
    expect(await seededFiles(res.json().service.builderChatId)).toEqual(encoded(serviceFiles()));

    const linked = await withExtraEntries(archive, [{ name: 'app/secrets', symlinkTo: '/etc/passwd' }]);
    const before = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.tenantId, elsewhere.tenant.tenantId));
    const refused = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, linked),
      slug: uniqueSlug('linked'),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      code: 'import_refused',
      problems: [expect.objectContaining({ path: 'secrets' })],
    });
    const after = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.tenantId, elsewhere.tenant.tenantId));
    expect(after).toHaveLength(before.length);
  });

  it('refuses a newer export format, but not an older one', async () => {
    const archive = await exportOf(await sourceService());
    const newer = await rewriteManifest(archive, (manifest) => {
      (manifest.stamp as Record<string, unknown>).exportFormatVersion = 99;
    });
    const older = await rewriteManifest(archive, (manifest) => {
      (manifest.stamp as Record<string, unknown>).exportFormatVersion = 0;
    });

    const refused = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, newer),
      slug: uniqueSlug('newer'),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'export_format_unsupported' });
    const accepted = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, older),
      slug: uniqueSlug('older'),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
  });

  it('refuses a file with no app/service.json as not a service export', async () => {
    const archive = await packSkill([
      {
        path: 'manifest.json',
        content: Buffer.from(
          JSON.stringify({
            kind: 'external-service',
            stamp: {
              exportFormatVersion: 1,
              platformVersion: '1',
              agentImageVersion: '1',
              arch: 'x64',
              sdkVersion: null,
            },
            service: { name: 'Hollow', slug: 'hollow' },
          })
        ),
        executable: false,
      },
    ]);

    const res = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, archive),
      slug: uniqueSlug('hollow'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'not_a_service_export' });
  });

  it('imports an SDK 1 Export as a Draft with the rebuild warning, and Publish refuses it', async () => {
    const source = await sourceService(admin, '1.0.0');

    const res = await importRoute(elsewhere, {
      uploadId: await upload(elsewhere, await exportOf(source)),
      slug: uniqueSlug('sdk-one'),
    });

    expect(res.statusCode, res.body).toBe(201);
    const imported = res.json<{ service: CreatedCustomService; warnings: string[] }>();
    expect(imported.warnings).toEqual([
      'Built on SDK 1: rebuild it on SDK 2 or delete it; Publish refuses it until then',
    ]);
    const published = await publishService(app, elsewhere, imported.service.id, {
      environmentId: await productionEnvironmentOf(elsewhere.tenant.tenantId),
    });
    expect(published.statusCode).toBe(409);
    expect(published.json()).toMatchObject({ code: 'built-on-sdk-1' });
  });
});

function projectManifest(): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: 'project',
      title: 'A project',
      description: null,
      agentName: null,
      agent: null,
      settings: {},
      resources: {},
      appDetails: null,
      schedules: [],
      stamp: { exportFormatVersion: 1, platformVersion: '1.0.0', agentImageVersion: '1.0.0', arch: 'x64' },
    })
  );
}

describe('kind gating', () => {
  it('refuses a Project or an Agent export on the service side', async () => {
    for (const [kind, expected] of [
      ['project', 'Project export'],
      ['agent', 'Agent export'],
    ] as const) {
      const manifest =
        kind === 'project' ? projectManifest() : Buffer.from(JSON.stringify({ kind: 'agent', stamp: {} }));
      const archive = await packSkill([{ path: 'manifest.json', content: manifest, executable: false }]);
      const res = await importRoute(elsewhere, {
        uploadId: await upload(elsewhere, archive),
        slug: uniqueSlug('kind'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'not_a_service_export', message: expect.stringContaining(expected) });
    }
  });

  it('refuses a service export on the Agent and the Project side', async () => {
    const archivePath = join(storageRoot, `${randomUUID()}.zip`);
    await writeFile(archivePath, await exportOf(await sourceService()));
    const caller = { tenantId: elsewhere.tenant.tenantId, userId: elsewhere.userId, canManageAgents: true };

    const agentSide = await app
      .get(AgentImportService)
      .import(caller, archivePath, { displayName: null, projectSettings: {} }, { canConfigureProjects: true })
      .catch((error: { getResponse: () => unknown }) => error.getResponse());
    expect(agentSide).toMatchObject({
      code: 'not_an_agent_export',
      message: expect.stringContaining('External Service export'),
    });

    const projectSide = await app
      .get(ProjectImportService)
      .startImport({
        tenantId: elsewhere.tenant.tenantId,
        workspaceId: null,
        folderId: null,
        userId: elsewhere.userId,
        canManageWorkspaces: false,
        titleOverride: null,
        timezone: 'UTC',
        uploadPath: archivePath,
      })
      .catch((error: { getResponse: () => unknown }) => error.getResponse());
    expect(JSON.stringify(projectSide)).toContain('External Service export');
  });
});

describe('who can copy a service', () => {
  it('lets only can_manage_tenant_external_services export, preview, duplicate, import and upload', async () => {
    const source = await sourceService();
    const outsider = await memberWithout(app);

    expect((await exportRoute(outsider, source.id)).statusCode).toBe(403);
    expect((await exportRoute(outsider, source.id, '/preview')).statusCode).toBe(403);
    expect((await duplicateRoute(outsider, source.id, { name: 'X', slug: uniqueSlug('x') })).statusCode).toBe(403);
    expect((await importRoute(outsider, { uploadId: randomUUID() })).statusCode).toBe(403);

    const session = (person: PersonFixture) =>
      app.inject({
        method: 'POST',
        url: '/api/projects/import/uploads',
        headers: person.headers,
        payload: { size: 10 },
      });
    expect((await session(outsider)).statusCode).toBe(403);
    expect((await session(admin)).statusCode).toBe(201);
  });
});

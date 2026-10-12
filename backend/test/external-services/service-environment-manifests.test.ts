import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { manifestDiff } from '../../src/external-services/publishing/manifest-diff';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { memberWithout, tenantAdmin, type PersonFixture } from './support/fixtures';
import {
  addServiceEnvironment,
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import { committedWorkspace, publishReview } from './support/service-publishing';
import { runningDevelopment, type BuilderDevelopment } from './support/test-lane';

const BOARD_OPTIONS = [
  { value: 'b1', label: 'Roadmap' },
  { value: 'b2', label: 'Operations' },
];

const BOARD_INPUT = {
  type: 'object',
  required: ['boardId'],
  properties: { boardId: { type: 'string', boundTo: 'board' } },
};

const PRODUCTION_MANIFEST = {
  sdk: 1,
  displayName: 'Boards',
  description: 'A pretend board tool the Organization built itself.',
  inbound: true,
  projectForm: [{ key: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS }],
  operations: {
    list_cards: { kind: 'read', title: 'List cards', description: 'List the cards on one board.', input: BOARD_INPUT },
    delete_card: { kind: 'destructive', description: 'Delete a card.', input: BOARD_INPUT },
  },
  events: {
    'card.created': { title: 'Card created', description: 'A card was added to a board.', data: BOARD_INPUT },
  },
  bounds: { board: { path: 'boards' } },
} as const;

const DEVELOPMENT_MANIFEST = {
  ...PRODUCTION_MANIFEST,
  operations: {
    list_cards: { ...PRODUCTION_MANIFEST.operations.list_cards, kind: 'write' },
    archive_card: { kind: 'write', description: 'Archive a card.', input: BOARD_INPUT },
  },
};

const STAGING_MANIFEST = {
  ...PRODUCTION_MANIFEST,
  projectForm: [{ key: 'boardIds', was: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS }],
  bounds: { board: { path: 'boardIds' } },
};

const asManifest = (manifest: unknown) => manifest as ServiceManifest;

describe('the manifest diff between two versions of a service', () => {
  it('marks added, removed, unchanged and kind-changed Operations', () => {
    const diff = manifestDiff(asManifest(PRODUCTION_MANIFEST), asManifest(DEVELOPMENT_MANIFEST));

    expect(diff.operations).toEqual([
      { name: 'list_cards', kind: 'write', change: 'changed', aspects: ['kind'] },
      { name: 'archive_card', kind: 'write', change: 'added', aspects: [] },
      { name: 'delete_card', kind: 'destructive', change: 'removed', aspects: [] },
    ]);
    expect(diff.events).toEqual([{ type: 'card.created', change: 'unchanged', aspects: [] }]);
  });

  it('marks a changed bound target on every Operation and Event that uses the bound', () => {
    const diff = manifestDiff(asManifest(PRODUCTION_MANIFEST), asManifest(STAGING_MANIFEST));

    expect(diff.operations.map((operation) => [operation.name, operation.change, operation.aspects])).toEqual([
      ['list_cards', 'changed', ['bounds']],
      ['delete_card', 'changed', ['bounds']],
    ]);
    expect(diff.events).toEqual([{ type: 'card.created', change: 'changed', aspects: ['bounds'] }]);
  });

  it('compares input schemas through $defs and notices title and description edits', () => {
    const before = {
      ...PRODUCTION_MANIFEST,
      $defs: { Board: BOARD_INPUT },
      operations: { list_cards: { ...PRODUCTION_MANIFEST.operations.list_cards, input: { $ref: '#/$defs/Board' } } },
    };
    const inlined = { ...PRODUCTION_MANIFEST, operations: { list_cards: PRODUCTION_MANIFEST.operations.list_cards } };
    const widened = {
      ...inlined,
      operations: {
        list_cards: {
          ...inlined.operations.list_cards,
          title: 'Cards',
          description: 'List cards.',
          input: { ...BOARD_INPUT, properties: { ...BOARD_INPUT.properties, limit: { type: 'integer' } } },
        },
      },
    };

    expect(manifestDiff(asManifest(before), asManifest(inlined)).operations[0]?.change).toBe('unchanged');
    expect(manifestDiff(asManifest(inlined), asManifest(widened)).operations[0]?.aspects).toEqual([
      'input',
      'title',
      'description',
    ]);
  });

  it('marks everything added when there is nothing to compare against', () => {
    const diff = manifestDiff(null, asManifest(PRODUCTION_MANIFEST));

    expect(diff.operations.map((operation) => operation.change)).toEqual(['added', 'added']);
    expect(diff.events.map((event) => event.change)).toEqual(['added']);
  });
});

describe("a Custom External Service's manifest in each environment", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let development: BuilderDevelopment;
  let staging: string;
  let qa: string;
  let pod: FakeServicePod;

  const environmentManifests = (person: PersonFixture = admin) =>
    app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}/manifests`, headers: person.headers });

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'environment-manifests-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot, OPSIFORCE_PUBLIC_URL: 'https://opsiforce.example.com' },
      servicePodPort: podPort,
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, {
      slug: `boards-${crypto.randomUUID().slice(0, 6)}`,
      manifest: PRODUCTION_MANIFEST,
    });
    pod = await startFakeServicePod({ manifest: PRODUCTION_MANIFEST, gatewayKey: service.key, port: podPort });
    development = await runningDevelopment(app, storageRoot, service.builderChatId, DEVELOPMENT_MANIFEST);
    const environments = app.get(EnvironmentService);
    staging = (await environments.create(admin.tenant.tenantId, { name: 'Staging', slug: 'staging' })).id;
    qa = (await environments.create(admin.tenant.tenantId, { name: 'QA', slug: 'qa' })).id;
    const stagingInstance = await addServiceEnvironment(app, service.builderChatId, admin.tenant.tenantId, staging);
    await writeServiceFiles(storageRoot, stagingInstance.directory, STAGING_MANIFEST);
  });

  afterEach(async () => {
    await pod.close();
  });

  it('reads Development and every published environment, diffed against the Default environment', async () => {
    const consumer = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, consumer, service.slug, {
      boards: ['b1'],
      operations: { list_cards: true, delete_card: true },
    });

    const res = await environmentManifests();

    expect(res.statusCode, res.body).toBe(200);
    const byName = Object.fromEntries(
      (res.json() as { name: string }[]).map((environment) => [environment.name, environment])
    );
    expect(Object.keys(byName)).toEqual(['Development', 'Production', 'QA', 'Staging']);
    expect(byName.Development).toMatchObject({
      environmentId: development.environmentId,
      status: 'development',
      serviceDefault: false,
      publishedCommitSha: null,
      manifest: { operations: { list_cards: { kind: 'write' }, archive_card: { kind: 'write' } } },
      changes: {
        operations: [
          { name: 'list_cards', change: 'changed', aspects: ['kind'] },
          { name: 'archive_card', change: 'added' },
          { name: 'delete_card', kind: 'destructive', change: 'removed' },
        ],
        events: [{ type: 'card.created', change: 'unchanged' }],
      },
      removedInUse: [{ operation: 'delete_card', configurations: 1 }],
    });
    expect(byName.Production).toMatchObject({
      environmentId: service.environmentId,
      serviceDefault: true,
      status: 'development-differs',
      manifest: { operations: { delete_card: { kind: 'destructive' } } },
      changes: null,
      removedInUse: [],
    });
    expect(byName.Staging).toMatchObject({
      environmentId: staging,
      serviceDefault: false,
      status: 'development-differs',
      changes: {
        operations: [
          { name: 'list_cards', change: 'changed', aspects: ['bounds'] },
          { name: 'delete_card', change: 'changed', aspects: ['bounds'] },
        ],
      },
      removedInUse: [],
    });
    expect(byName.QA).toEqual({
      environmentId: qa,
      name: 'QA',
      status: 'unpublished',
      serviceDefault: false,
      publishedCommitSha: null,
      manifest: null,
      changes: null,
      removedInUse: [],
    });
  });

  it("says an environment is the same as Development until Development's app/ changes", async () => {
    const workspace = join(storageRoot, development.directory);
    const commit = await committedWorkspace(workspace);
    await db
      .update(projectEnvironments)
      .set({ deployedCommitSha: commit })
      .where(eq(projectEnvironments.id, service.projectEnvironmentId));
    const statusOfProduction = async () =>
      (await environmentManifests()).json().find((environment: { name: string }) => environment.name === 'Production')
        ?.status;

    expect(await statusOfProduction()).toBe('same-as-development');

    await writeFile(join(workspace, 'app', 'handlers.ts'), 'export default {};\n');

    expect(await statusOfProduction()).toBe('development-differs');
  });

  it('is refused to people who cannot manage the Organization’s External Services', async () => {
    expect((await environmentManifests(await memberWithout(app))).statusCode).toBe(403);
  });

  it("marks each Operation and Event of the Publish dialog's check against the chosen environment", async () => {
    const toStaging = (await publishReview(app, admin, service.id, staging)).json();
    const toQa = (await publishReview(app, admin, service.id, qa)).json();

    expect(toStaging.changes).toEqual({
      operations: [
        { name: 'list_cards', kind: 'write', change: 'changed', aspects: ['kind', 'bounds'] },
        { name: 'archive_card', kind: 'write', change: 'added', aspects: [] },
        { name: 'delete_card', kind: 'destructive', change: 'removed', aspects: [] },
      ],
      events: [{ type: 'card.created', change: 'changed', aspects: ['bounds'] }],
    });
    expect(toQa.changes.operations.map((operation: { change: string }) => operation.change)).toEqual([
      'added',
      'added',
    ]);
  });
});

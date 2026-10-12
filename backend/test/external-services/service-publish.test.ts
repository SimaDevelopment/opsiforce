import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceConfigs, projectPublishJobs } from '../../db/schema';
import { callersOwner } from '../../src/external-services/configuration/configuration-values';
import { ServiceConfigurationStore } from '../../src/external-services/configuration/service-configuration.store';
import { ServiceDefaultEnvironments } from '../../src/external-services/publishing/service-default-environments';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { Perms } from '../../src/permission/permission.constants';
import { PublishController } from '../../src/publish/publish.controller';
import { PublishModule } from '../../src/publish/publish.module';
import { PROJECT_PUBLISH_QUEUE } from '../../src/publish/publish.types';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import type { FakeQueue } from '../support/infra-fakes';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callOperation } from './support/gate';
import {
  consumerIn,
  freePort,
  productionEnvironmentOf,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import { publishReview, publishService } from './support/service-publishing';
import {
  builderLane,
  createTestProject,
  runningDevelopment,
  saveTestProjectConfiguration,
  storeServiceConfigurationRaw,
  type BuilderDevelopment,
} from './support/test-lane';

const BOARD_OPTIONS = [
  { value: 'b1', label: 'Roadmap' },
  { value: 'b2', label: 'Operations' },
];

const BOARD_INPUT = {
  type: 'object',
  required: ['boardId'],
  properties: { boardId: { type: 'string', boundTo: 'board' } },
};

const PUBLISHED_MANIFEST = {
  sdk: 1,
  displayName: 'Boards',
  description: 'A pretend board tool the Organization built itself.',
  serviceForm: [{ key: 'apiToken', type: 'secret', label: 'API token', required: true }],
  projectForm: [{ key: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS }],
  operations: {
    list_cards: { kind: 'read', description: 'List the cards on one board.', input: BOARD_INPUT },
    delete_card: { kind: 'destructive', description: 'Delete a card.', input: BOARD_INPUT },
  },
  bounds: { board: { path: 'boards' } },
};

const NEXT_MANIFEST = {
  ...PUBLISHED_MANIFEST,
  serviceForm: [
    { key: 'apiToken', type: 'secret', label: 'API token', required: true },
    {
      key: 'region',
      type: 'select',
      label: 'Region',
      required: true,
      options: [
        { value: 'eu', label: 'EU' },
        { value: 'us', label: 'US' },
      ],
    },
    { key: 'signingKey', type: 'secret', label: 'Signing key', required: true },
    { key: 'webhookToken', type: 'secret', label: 'Webhook token', generate: { bytes: 32 } },
  ],
  projectForm: [
    { key: 'boardIds', was: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS },
    {
      key: 'team',
      type: 'select',
      label: 'Team',
      required: true,
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    },
  ],
  operations: {
    list_cards: PUBLISHED_MANIFEST.operations.list_cards,
    archive_card: { kind: 'write', description: 'Archive a card.', input: BOARD_INPUT },
  },
  bounds: { board: { path: 'boardIds' } },
};

const GENERATING_MANIFEST = {
  ...PUBLISHED_MANIFEST,
  serviceForm: [
    ...PUBLISHED_MANIFEST.serviceForm,
    { key: 'webhookToken', type: 'secret', label: 'Webhook token', generate: { bytes: 32 } },
  ],
};

const RENAMING_MANIFEST = {
  ...PUBLISHED_MANIFEST,
  serviceForm: [
    { key: 'token', was: 'apiToken', type: 'secret', label: 'API token', required: true },
    NEXT_MANIFEST.serviceForm[1],
  ],
};

@Module({ imports: [PublishModule], controllers: [PublishController] })
class ProjectPublishRoutes {}

describe('publishing a Custom External Service through its Publish dialog', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let development: BuilderDevelopment;
  let production: string;
  let pod: FakeServicePod;

  const publishQueue = () => app.get<FakeQueue>(getQueueToken(PROJECT_PUBLISH_QUEUE));
  const queuedPublishes = () =>
    publishQueue()
      .callsTo('add')
      .filter((call) => (call.args.data as { projectId?: string }).projectId === service.builderChatId);

  const storedCallersValues = async () => {
    const rows = await db
      .select()
      .from(externalServiceConfigs)
      .where(eq(externalServiceConfigs.externalServiceId, service.id));
    return rows.find((row) => row.environment === null)?.values as Record<string, unknown>;
  };

  const openCallersSecret = (values: Record<string, unknown>, key: string) =>
    app.get(SecretSealer).open(values[key] as never, `${service.id}|${service.tenantId}|${key}`);

  const landPublish = async (manifest: unknown) => {
    await writeServiceFiles(storageRoot, service.directory, manifest);
    await pod.close();
    pod = await startFakeServicePod({ manifest, gatewayKey: service.key, port: podPort });
    await app.get(ServiceDefaultEnvironments).publishedTo(service.builderChatId, service.projectEnvironmentId);
  };

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'service-publish-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot, OPSIFORCE_PUBLIC_URL: 'https://opsiforce.example.com' },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_000,
      extraModules: [ProjectPublishRoutes],
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
      manifest: PUBLISHED_MANIFEST,
    });
    pod = await startFakeServicePod({ manifest: PUBLISHED_MANIFEST, gatewayKey: service.key, port: podPort });
    expect((await saveCustomServiceConfiguration(app, admin, service.id, { apiToken: 'live-token' })).statusCode).toBe(
      200
    );
    development = await runningDevelopment(app, storageRoot, service.builderChatId, NEXT_MANIFEST);
    const developmentService = await app.get(ServiceRegistry).development(service.id);
    if (!developmentService) throw new Error('Development is not servable');
    await app.get(ServiceConfigurationStore).saveAndReport(developmentService, callersOwner(developmentService), {
      apiToken: 'dev-token',
      region: 'us',
      signingKey: 'dev-signing-key',
    });
    production = await productionEnvironmentOf(admin.tenant.tenantId);
    pod.receivedHooks.length = 0;
  });

  afterEach(async () => {
    await pod.close();
  });

  it('reports the impact on existing Project configurations: renamed via was, now missing, new Operations off', async () => {
    const first = await consumerIn(app, admin.tenant);
    const second = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, first, service.slug, {
      boards: ['b1'],
      operations: { list_cards: true, delete_card: true },
    });
    await saveConsumerConfiguration(app, second, service.slug, { boards: ['b2'] });
    const testProject = await createTestProject(app, development.key);
    expect(
      (await saveTestProjectConfiguration(app, development.key, { boardIds: ['b1'], team: 'red' })).statusCode
    ).toBe(200);

    const res = await publishReview(app, admin, service.id, production);

    expect(res.statusCode, res.body).toBe(200);
    const review = res.json();
    expect(review.target).toMatchObject({ firstPublish: false, becomesDefault: true });
    expect(review.impact).toMatchObject({
      configurations: 2,
      renamed: [{ from: 'boards', to: 'boardIds', configurations: 2 }],
      needsAttention: [{ field: 'team', configurations: 2 }],
      newOperationsOff: [{ operation: 'archive_card', configurations: 2 }],
      removedOperations: [{ operation: 'delete_card', configurations: 1 }],
    });
    expect(review.impact.consumers.map((consumer: { projectId: string }) => consumer.projectId).toSorted()).toEqual(
      [first.projectId, second.projectId].toSorted()
    );
    expect(review.impact.consumers.map((consumer: { projectId: string }) => consumer.projectId)).not.toContain(
      testProject.id
    );
  });

  it('lists every newly required Service configuration field and which ones Development can fill', async () => {
    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.serviceConfiguration.fields.map((field: { key: string }) => field.key)).toEqual([
      'region',
      'signingKey',
    ]);
    expect(review.serviceConfiguration.fromDevelopment).toEqual(['region', 'signingKey']);
  });

  it('refuses to publish while a newly required field is unmet, and queues nothing', async () => {
    const res = await publishService(app, admin, service.id, { environmentId: production, values: { region: 'eu' } });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-configuration',
      errors: [expect.objectContaining({ pointer: '/signingKey' })],
    });
    expect(queuedPublishes()).toEqual([]);
    expect(Object.keys(await storedCallersValues())).toEqual(['apiToken']);
  });

  it('refuses a Copy from Development of a field Development has no value for', async () => {
    await storeServiceConfigurationRaw(service.id, service.tenantId, 'development', {});

    const res = await publishService(app, admin, service.id, {
      environmentId: production,
      values: { region: 'eu' },
      copyFromDevelopment: ['signingKey'],
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().errors).toEqual([{ pointer: '/signingKey', message: 'has no value in Development to copy' }]);
  });

  it('saves the filled fields with the Publish, copies from Development re-sealed, and queues the Publish', async () => {
    const res = await publishService(app, admin, service.id, {
      environmentId: production,
      values: { region: 'eu' },
      copyFromDevelopment: ['signingKey'],
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ environmentId: production, status: 'queued' });
    const [job] = await db.select().from(projectPublishJobs).where(eq(projectPublishJobs.id, res.json().id));
    expect(job).toMatchObject({ projectId: service.builderChatId, environmentId: production });
    expect(queuedPublishes()).toHaveLength(1);
    const stored = await storedCallersValues();
    expect(stored.region).toBe('eu');
    expect(openCallersSecret(stored, 'signingKey')).toBe('dev-signing-key');
    expect(openCallersSecret(stored, 'apiToken')).toBe('live-token');
    expect(pod.receivedHooks).toEqual([]);
  });

  it('runs the Service configuration hook on the new version once the Publish lands', async () => {
    await publishService(app, admin, service.id, {
      environmentId: production,
      values: { region: 'eu' },
      copyFromDevelopment: ['signingKey'],
    });

    await landPublish(NEXT_MANIFEST);

    expect(pod.receivedHooks).toEqual([
      expect.objectContaining({
        hook: 'onServiceConfigurationSaved',
        previous: { apiToken: 'live-token' },
        current: expect.objectContaining({ apiToken: 'live-token', region: 'eu', signingKey: 'dev-signing-key' }),
      }),
    ]);
    const view = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}`,
      headers: admin.headers,
    });
    expect(view.json().hookFailure).toBeNull();
  });

  it('fills generated fields the new version newly declares once the Publish lands', async () => {
    await writeServiceFiles(storageRoot, development.directory, GENERATING_MANIFEST);
    const review = (await publishReview(app, admin, service.id, production)).json();
    expect(review.serviceConfiguration.fields).toEqual([]);
    expect((await publishService(app, admin, service.id, { environmentId: production })).statusCode).toBe(202);
    expect(await storedCallersValues()).not.toHaveProperty('webhookToken');

    await landPublish(GENERATING_MANIFEST);

    expect(String(openCallersSecret(await storedCallersValues(), 'webhookToken'))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps the live version configured until the Publish lands, though the new version renames a field', async () => {
    await writeServiceFiles(storageRoot, development.directory, RENAMING_MANIFEST);
    const consumer = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, consumer, service.slug, { boards: ['b1'] });
    const listCards = () =>
      callOperation(app, { key: consumer.key, slug: service.slug, operation: 'list_cards', input: { boardId: 'b1' } });

    expect(
      (await publishService(app, admin, service.id, { environmentId: production, values: { region: 'eu' } })).statusCode
    ).toBe(202);

    const beforeLanding = await listCards();
    expect(beforeLanding.statusCode, beforeLanding.body).toBe(200);
    expect(pod.received.at(-1)?.serviceConfiguration).toMatchObject({ apiToken: 'live-token' });

    await landPublish(RENAMING_MANIFEST);
    expect(pod.receivedHooks.at(-1)).toMatchObject({ previous: { token: 'live-token' } });

    const afterLanding = await listCards();
    expect(afterLanding.statusCode, afterLanding.body).toBe(200);
    expect(pod.received.at(-1)?.serviceConfiguration).toMatchObject({ token: 'live-token', region: 'eu' });
  });

  it('lets only humans publish: the builder agent has no route to it', async () => {
    const asBuilder = await publishService(
      app,
      admin,
      service.id,
      { environmentId: production, values: { region: 'eu' }, copyFromDevelopment: ['signingKey'] },
      { authorization: `Bearer ${development.key}` }
    );
    const throughTheLane = await builderLane(app, development.key, {
      method: 'POST',
      path: '/publish',
      payload: { environmentId: production },
    });

    expect([401, 403]).toContain(asBuilder.statusCode);
    expect(throughTheLane.statusCode).toBe(404);
    expect(queuedPublishes()).toEqual([]);
  });

  it("sends a builder chat's Publish (App) to the service page, so Stop 2 cannot be skipped", async () => {
    const publisher = await addMember(app, admin.tenant, [Perms.publishProject, Perms.manageTenantExternalServices]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${service.builderChatId}/publish`,
      headers: publisher.headers,
      payload: { environmentId: production },
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'publish-from-service-page' });
    expect(queuedPublishes()).toEqual([]);
  });

  it('asks for every Service configuration field on the first Publish', async () => {
    const draft = await createCustomService(app, admin, 'Draft boards', `draft-${crypto.randomUUID().slice(0, 6)}`);
    await runningDevelopment(app, storageRoot, draft.builderChatId, NEXT_MANIFEST);

    const review = (await publishReview(app, admin, draft.id, production)).json();

    expect(review.target).toMatchObject({ firstPublish: true, becomesDefault: true });
    expect(review.serviceConfiguration.fields.map((field: { key: string }) => field.key)).toEqual([
      'apiToken',
      'region',
      'signingKey',
      'webhookToken',
    ]);
    const refused = await publishService(app, admin, draft.id, { environmentId: production });
    expect(refused.statusCode).toBe(400);
    const accepted = await publishService(app, admin, draft.id, {
      environmentId: production,
      values: { apiToken: 'first-token', region: 'eu', signingKey: 'first-signing' },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
  });
});

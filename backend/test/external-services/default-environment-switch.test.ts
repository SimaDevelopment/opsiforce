import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { allowAll, route, type RouteHandler } from '@opsiforce/external-service-sdk';
import { createFileServiceState } from '@opsiforce/external-service-sdk/server';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callThroughGate, gatewayUrlOf } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import {
  addServiceEnvironment,
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import { environmentStateFile, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';
import { defaultEnvironmentReview, serviceEnvironments, switchDefaultEnvironment } from './support/service-publishing';

const STAGING_MANIFEST = {
  ...BOARDS_MANIFEST,
  description: 'The board tool, renamed fields and all.',
  projectForm: [{ ...BOARDS_MANIFEST.projectForm[0], key: 'boards', was: 'boardIds' }],
};

describe('switching the Default environment of a Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let staging: { environmentId: string; projectEnvironmentId: string; directory: string; key: string };
  let consumer: GateCallerFixture;
  let gatewayUrl: string;
  let pod: Sdk2ServicePod;

  const startPod = (
    copy: { key: string; directory: string },
    manifest: unknown,
    handle: RouteHandler = () => Response.json({})
  ) =>
    startSdk2ServicePod({
      manifest,
      gatewayKey: copy.key,
      gatewayUrl,
      stateFile: environmentStateFile(storageRoot, copy.directory),
      port: podPort,
      routes: () => [route('GET /cards', { summary: 'Lists the cards', allowedBy: [], check: allowAll, handle })],
    });

  const listCards = () => callThroughGate(app, { credential: `Bearer ${consumer.key}`, slug: service.slug }, '/cards');

  const serviceView = () =>
    app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}`, headers: admin.headers });

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'default-switch-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot, OPSIFORCE_PUBLIC_URL: 'https://opsiforce.example.com' },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_000,
    });
    app = harness.app;
    gatewayUrl = gatewayUrlOf(await harness.listen());
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, {
      slug: `boards-${crypto.randomUUID().slice(0, 6)}`,
    });
    const environment = await app
      .get(EnvironmentService)
      .create(admin.tenant.tenantId, { name: 'Staging', slug: 'staging' });
    staging = {
      environmentId: environment.id,
      ...(await addServiceEnvironment(app, service.builderChatId, admin.tenant.tenantId, environment.id)),
    };
    await writeServiceFiles(storageRoot, staging.directory, STAGING_MANIFEST);
    pod = await startPod(service, BOARDS_MANIFEST, async (_request, ctx) => {
      await ctx.state.set('upstreamWebhook', 'wh-1');
      return Response.json({ from: 'production' });
    });
    expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, consumer, service.slug, { boardIds: ['b1'] });
  });

  afterEach(async () => {
    await pod.close();
  });

  it("lists the Organization's environments with the service's published versions and its Default", async () => {
    const res = await serviceEnvironments(app, admin, service.id);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        environmentId: service.environmentId,
        name: 'Production',
        published: true,
        serviceDefault: true,
      }),
      expect.objectContaining({
        environmentId: staging.environmentId,
        name: 'Staging',
        published: true,
        serviceDefault: false,
      }),
    ]);
  });

  it('shows the same impact report as a Publish before switching', async () => {
    const res = await defaultEnvironmentReview(app, admin, service.id, staging.environmentId);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      target: { environmentId: staging.environmentId, name: 'Staging' },
      current: { environmentId: service.environmentId, name: 'Production' },
      check: { ok: true },
      impact: { configurations: 1, renamed: [{ from: 'boardIds', to: 'boards', configurations: 1 }] },
      serviceConfiguration: { fields: [] },
    });
  });

  it("moves callers to the chosen environment, copying the old Default's ctx.state file, and keeps the webhook URL", async () => {
    expect(await (await listCards()).json()).toEqual({ from: 'production' });
    const webhookUrl = (await serviceView()).json().webhookUrl;

    const res = await switchDefaultEnvironment(app, admin, service.id, { environmentId: staging.environmentId });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ environmentId: staging.environmentId, name: 'Staging' });
    const [row] = await db.select().from(externalServices).where(eq(externalServices.id, service.id));
    expect(row?.defaultEnvironmentId).toBe(staging.environmentId);
    await pod.close();
    pod = await startPod(staging, STAGING_MANIFEST, async (_request, ctx) =>
      Response.json({ from: 'staging', webhook: await ctx.state.get('upstreamWebhook') })
    );
    const answer = await listCards();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ from: 'staging', webhook: 'wh-1' });
    expect((await serviceView()).json()).toMatchObject({
      webhookUrl,
      defaultEnvironment: { environmentId: staging.environmentId, name: 'Staging' },
    });
  });

  it('refuses an environment without a published version, Development, and a service never published', async () => {
    const empty = await app.get(EnvironmentService).create(admin.tenant.tenantId, { name: 'QA', slug: 'qa' });
    const draft = await createCustomService(app, admin, 'Draft', `draft-${crypto.randomUUID().slice(0, 6)}`);

    const unpublished = await switchDefaultEnvironment(app, admin, service.id, { environmentId: empty.id });
    const toDevelopment = await switchDefaultEnvironment(app, admin, service.id, {
      environmentId: (await app.get(EnvironmentService).ensureDefaultForTenant(admin.tenant.tenantId)).id,
    });
    const neverPublished = await switchDefaultEnvironment(app, admin, draft.id, {
      environmentId: staging.environmentId,
    });

    expect(unpublished.statusCode).toBe(409);
    expect(unpublished.json()).toMatchObject({ type: 'urn:opsiforce:error:not-published' });
    expect(toDevelopment.statusCode).toBe(400);
    expect(toDevelopment.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-environment' });
    expect(neverPublished.statusCode).toBe(409);
    const [row] = await db.select().from(externalServices).where(eq(externalServices.id, service.id));
    expect(row?.defaultEnvironmentId).toBe(service.environmentId);
  });

  it('runs two switches one after the other, the last one leaving the state where callers land', async () => {
    await createFileServiceState(environmentStateFile(storageRoot, service.directory)).set('registration', 'wh-7');
    const qaEnvironment = await app.get(EnvironmentService).create(admin.tenant.tenantId, { name: 'QA', slug: 'qa' });
    const qa = await addServiceEnvironment(app, service.builderChatId, admin.tenant.tenantId, qaEnvironment.id);
    await writeServiceFiles(storageRoot, qa.directory, STAGING_MANIFEST);

    const [toStaging, toQa] = await Promise.all([
      switchDefaultEnvironment(app, admin, service.id, { environmentId: staging.environmentId }),
      switchDefaultEnvironment(app, admin, service.id, { environmentId: qaEnvironment.id }),
    ]);

    expect([toStaging.statusCode, toQa.statusCode]).toEqual([200, 200]);
    const [row] = await db.select().from(externalServices).where(eq(externalServices.id, service.id));
    const landed = row?.defaultEnvironmentId === qaEnvironment.id ? qa.directory : staging.directory;
    expect([staging.environmentId, qaEnvironment.id]).toContain(row?.defaultEnvironmentId);
    expect(await createFileServiceState(environmentStateFile(storageRoot, landed)).get('registration')).toBe('wh-7');
  });

  it('starts the new Default empty when the old one kept no state', async () => {
    const stagingState = environmentStateFile(storageRoot, staging.directory);
    await createFileServiceState(stagingState).set('left-over', 1);

    const res = await switchDefaultEnvironment(app, admin, service.id, { environmentId: staging.environmentId });

    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(stagingState)).toBe(false);
  });
});

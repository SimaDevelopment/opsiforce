import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { verifyCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceProjectConfigs, type JsonValue } from '../../db/schema';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { PodService } from '../../src/pod/pod.service';
import { AppReadinessService } from '../../src/project/app-readiness.service';
import type { FakePodService } from '../support/infra-fakes';
import { disableProject } from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callAsGate, gatewayUrlOf, resolveCaller, resolved } from './support/gate-proxy';
import { productionCaller, type GateCallerFixture } from './support/gate';
import {
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  serviceEnvironmentRow,
  suspendServicePod,
  type PublishedService,
} from './support/published-services';
import { revealed, SDK2_BOARDS_MANIFEST, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';
import {
  createTestProject,
  runningDevelopment,
  saveDevelopmentConfiguration,
  saveTestProjectConfiguration,
  type BuilderDevelopment,
  type CreatedTestProject,
} from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';
const START_HOLD_MS = 1_500;
const READY_SDK2_BOARDS = { apiToken: 'boards-api-token-1', region: 'eu' };
const DEVELOPMENT_SDK2_BOARDS = { apiToken: 'boards-development-token', region: 'us' };
function basic(userAndPassword: string): string {
  return `Basic ${Buffer.from(userAndPassword).toString('base64')}`;
}

const SDK2_DEVELOPMENT_MANIFEST = { ...SDK2_BOARDS_MANIFEST, description: 'The board tool, as Development serves it.' };

describe('an SDK 2 service reached through the Gate', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let consumer: GateCallerFixture;
  let pods: Sdk2ServicePod[];

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-gate-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: START_HOLD_MS,
    });
    app = harness.app;
    backendUrl = await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pods = [];
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: SDK2_BOARDS_MANIFEST });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_SDK2_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
  });

  afterEach(async () => {
    for (const pod of pods) await pod.close();
  });

  async function startPod(gatewayKey = service.key): Promise<Sdk2ServicePod> {
    const pod = await startSdk2ServicePod({ gatewayKey, gatewayUrl: gatewayUrlOf(backendUrl), port: podPort });
    pods.push(pod);
    return pod;
  }

  it("resolves a Project's key to the Default copy's pod and a Caller identity only that copy accepts", async () => {
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
    const pod = await startPod();

    const answer = await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });
    const res = await callAsGate(answer, '/cards?board=b1');

    expect(answer).toMatchObject({
      upstream: `http://127.0.0.1:${podPort}`,
      tenantId: admin.tenant.tenantId,
      serviceId: service.id,
    });
    expect(verifyCallerIdentity(answer.callerIdentity, service.key)).toEqual({
      kind: 'call',
      tenantId: admin.tenant.tenantId,
      projectId: consumer.projectId,
      projectEnvironmentId: consumer.projectEnvironmentId,
      environment: expect.any(String),
    });
    const claims = JSON.parse(Buffer.from(answer.callerIdentity.split('.')[1] ?? '', 'base64url').toString());
    expect(Object.keys(claims).toSorted()).toEqual(
      ['environment', 'exp', 'iat', 'kind', 'projectEnvironmentId', 'projectId', 'tenantId'].toSorted()
    );
    expect(claims.exp - claims.iat).toBe(120);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(pod.received).toEqual([
      expect.objectContaining({
        path: '/cards',
        projectConfiguration: { boardIds: ['b1'] },
        serviceConfiguration: READY_SDK2_BOARDS,
      }),
    ]);
  });

  describe('finding the Gateway Key in the header the Gate found it in', () => {
    it.each([
      ['a bearer token', (key: string) => `Bearer ${key}`],
      ['a GitHub-style token', (key: string) => `token ${key}`],
      ['the bare key', (key: string) => key],
      ['the password of Basic credentials', (key: string) => basic(`x-access-token:${key}`)],
      ['the username of Basic credentials', (key: string) => basic(`${key}:x-oauth-basic`)],
      ['the username of Basic credentials with no password', (key: string) => basic(`${key}:`)],
    ])('reads it from %s', async (_shape, credentialOf) => {
      const res = await resolveCaller(app, { credential: credentialOf(consumer.key), slug: 'boards' });

      expect(res.statusCode, res.body).toBe(200);
      expect(verifyCallerIdentity(res.json().callerIdentity, service.key)).toMatchObject({
        projectEnvironmentId: consumer.projectEnvironmentId,
      });
    });
  });

  describe('refusing the caller with 401', () => {
    async function refusedWith401(credential: string | undefined) {
      const res = await resolveCaller(app, { ...(credential === undefined ? {} : { credential }), slug: 'boards' });
      expect(res.statusCode, res.body).toBe(401);
      expect(Object.keys(res.json())).toEqual(['message']);
      return res.json<{ message: string }>().message;
    }

    it('when no header carried a Gateway Key', async () => {
      expect(await refusedWith401(undefined)).toMatch(/Gateway Key/);
      expect(await refusedWith401('Bearer not-a-gateway-key')).toMatch(/Gateway Key/);
      expect(await refusedWith401(`Basic ${Buffer.from('user:password').toString('base64')}`)).toMatch(/Gateway Key/);
    });

    it('for an unknown key', async () => {
      expect(await refusedWith401(`Bearer gw-${crypto.randomUUID()}`)).toMatch(/unknown or revoked/);
    });

    it('for a revoked key', async () => {
      await app.get(GatewayKeyService).revokeEnvironmentKeys(consumer.projectEnvironmentId);

      expect(await refusedWith401(`Bearer ${consumer.key}`)).toMatch(/unknown or revoked/);
    });

    it('for the key of a disabled Project', async () => {
      await disableProject(consumer.projectId);

      expect(await refusedWith401(`Bearer ${consumer.key}`)).toMatch(/Project is disabled/);
    });
  });

  describe('answering 404 for a slug the caller cannot reach', () => {
    async function refusedWith404(slug: string, caller: GateCallerFixture = consumer) {
      const res = await resolveCaller(app, { credential: `Bearer ${caller.key}`, slug });
      expect(res.statusCode, res.body).toBe(404);
      expect(Object.keys(res.json())).toEqual(['message']);
      return res.json<{ message: string }>().message;
    }

    it('when no service has that slug in the Organization', async () => {
      expect(await refusedWith404('calendar')).toMatch(/no External Service "calendar"/);
    });

    it("when only another Organization's service has that slug", async () => {
      const stranger = await consumerIn(app, (await tenantAdmin(app)).tenant);

      expect(await refusedWith404('boards', stranger)).toMatch(/no External Service "boards"/);
    });

    it('when the service is disabled, with a message a caller can relay', async () => {
      await disableProject(service.builderChatId);

      expect(await refusedWith404('boards')).toBe('Fixture Boards is turned off in this Organization.');
    });

    it('when the service was never published', async () => {
      await createCustomService(app, admin, 'Drafts', 'drafts');

      expect(await refusedWith404('drafts')).toMatch(/no External Service "drafts"/);
    });

    it('when the service was deleted', async () => {
      const deleted = await app.inject({
        method: 'DELETE',
        url: `${TENANT_SERVICES}/${service.id}?confirmSlug=boards`,
        headers: admin.headers,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);

      expect(await refusedWith404('boards')).toMatch(/no External Service "boards"/);
    });

    it('for an SDK 1 service, which must be rebuilt or deleted', async () => {
      await publishCustomService(app, admin, storageRoot, {
        name: 'Legacy',
        slug: 'legacy',
        manifest: { ...BOARDS_MANIFEST, sdk: 1 },
      });

      expect(await refusedWith404('legacy')).toBe(
        '"legacy" is built on SDK 1 and must be rebuilt on SDK 2 or deleted.'
      );
    });
  });

  describe("the caller's configurations, read by the service from the backend", () => {
    it('refuses a Project that never connected the service as not connected, linking to its settings', async () => {
      await startPod();

      const res = await callAsGate(
        await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }),
        '/cards'
      );

      expect(res.status).toBe(403);
      expect(res.headers.get('opsiforce-outcome')).toBe('not connected');
      expect(await res.json()).toMatchObject({
        outcome: 'not connected',
        link: `${PUBLIC_URL}/projects/${consumer.projectId}?configure=boards`,
      });
    });

    it("links a refusal from another environment to that environment's settings", async () => {
      const production = await productionCaller(app, consumer);
      await startPod();

      const res = await callAsGate(
        await resolved(app, { credential: `Bearer ${production.key}`, slug: 'boards' }),
        '/cards'
      );

      expect(res.headers.get('opsiforce-outcome')).toBe('not connected');
      expect((await res.json()).link).toBe(
        `${PUBLIC_URL}/projects/${consumer.projectId}?configure=boards&environment=${production.projectEnvironmentId}`
      );
    });

    it('refuses a Project missing a required field as incomplete, naming the field and linking to it', async () => {
      await storeRawProjectConfiguration(service.id, consumer.projectEnvironmentId, { signingSecret: 'unsealed' });
      await startPod();

      const res = await callAsGate(
        await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }),
        '/cards'
      );

      expect(res.status).toBe(403);
      expect(res.headers.get('opsiforce-outcome')).toBe('incomplete');
      expect(res.headers.get('opsiforce-setting')).toBe('boardIds');
      const body = await res.json();
      expect(body.link).toBe(`${PUBLIC_URL}/projects/${consumer.projectId}?configure=boards&field=boardIds`);
      expect(body.message).toContain('"Boards"');
    });

    it("describes the caller's configuration and settings link at /.well-known/opsiforce, secrets masked", async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', {
        boardIds: ['b2'],
        signingSecret: 'project-signing-1',
      });
      await startPod();

      const res = await callAsGate(
        await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }),
        '/.well-known/opsiforce'
      );

      expect(res.status).toBe(200);
      const described = await res.json();
      expect(described).toMatchObject({
        sdk: '2.0.0',
        settingsLink: `${PUBLIC_URL}/projects/${consumer.projectId}?configure=boards`,
        configuration: {
          boardIds: { label: 'Boards', value: ['b2'] },
          signingSecret: { label: 'Signing secret', value: '[secret]' },
        },
      });
      expect(JSON.stringify(described)).not.toContain('project-signing-1');
    });

    it('opens the secrets of the Project configuration for the service', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', {
        boardIds: ['b1'],
        signingSecret: 'project-signing-1',
      });
      const pod = await startPod();

      await callAsGate(await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }), '/cards');

      expect(pod.received[0]?.projectConfiguration).toEqual({ boardIds: ['b1'], signingSecret: 'project-signing-1' });
    });

    it('lists every connected ProjectEnvironment of the Default lane for service.projectConfigurations()', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const other = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, other, 'boards', { boardIds: ['b2'] });
      await consumerIn(app, admin.tenant);
      const pod = await startPod();

      const listed = await pod.service.projectConfigurations();

      expect(listed.map((entry) => ({ ...entry, projectConfiguration: revealed(entry.projectConfiguration) }))).toEqual(
        expect.arrayContaining([
          {
            projectId: consumer.projectId,
            projectEnvironmentId: consumer.projectEnvironmentId,
            projectConfiguration: { boardIds: ['b1'] },
          },
          {
            projectId: other.projectId,
            projectEnvironmentId: other.projectEnvironmentId,
            projectConfiguration: { boardIds: ['b2'] },
          },
        ])
      );
      expect(listed).toHaveLength(2);
    });

    it("refuses a fetch with a key that is no service copy's", async () => {
      const res = await fetch(`${gatewayUrlOf(backendUrl)}/configuration`, {
        headers: { authorization: `Bearer ${consumer.key}` },
      });
      const unknown = await fetch(`${gatewayUrlOf(backendUrl)}/configuration`, {
        headers: { authorization: `Bearer gw-${crypto.randomUUID()}` },
      });

      expect(res.status).toBe(403);
      expect(unknown.status).toBe(401);
    });
  });

  describe("the builder's Test Project", () => {
    let development: BuilderDevelopment;
    let testProject: CreatedTestProject;

    beforeEach(async () => {
      development = await runningDevelopment(app, storageRoot, service.builderChatId, SDK2_DEVELOPMENT_MANIFEST);
      const saved = await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_SDK2_BOARDS);
      expect(saved.statusCode, saved.body).toBe(200);
      testProject = await createTestProject(app, development.key);
      const configured = await saveTestProjectConfiguration(app, development.key, { boardIds: ['b2'] });
      expect(configured.statusCode, configured.body).toBe(200);
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
    });

    it("resolves to the Development copy, whose pod reads Development's own Service configuration", async () => {
      const pod = await startPod(development.key);

      const answer = await resolved(app, { credential: `Bearer ${testProject.key}`, slug: 'boards' });
      const res = await callAsGate(answer, '/cards');

      expect(verifyCallerIdentity(answer.callerIdentity, service.key)).toBeUndefined();
      expect(verifyCallerIdentity(answer.callerIdentity, development.key)).toMatchObject({
        kind: 'call',
        projectId: testProject.id,
        projectEnvironmentId: testProject.projectEnvironmentId,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(pod.received[0]).toMatchObject({
        projectConfiguration: { boardIds: ['b2'] },
        serviceConfiguration: DEVELOPMENT_SDK2_BOARDS,
      });
      expect(revealed(await pod.service.configuration())).toEqual(DEVELOPMENT_SDK2_BOARDS);
    });

    it('keeps each lane to its own Projects in service.projectConfigurations()', async () => {
      const developmentPod = await startPod(development.key);
      const developmentLane = await developmentPod.service.projectConfigurations();
      await developmentPod.close();
      pods = [];
      const defaultPod = await startPod();
      const defaultLane = await defaultPod.service.projectConfigurations();

      expect(developmentLane.map((entry) => entry.projectEnvironmentId)).toEqual([testProject.projectEnvironmentId]);
      expect(defaultLane.map((entry) => entry.projectEnvironmentId)).toEqual([consumer.projectEnvironmentId]);
      expect(revealed(await defaultPod.service.configuration())).toEqual(READY_SDK2_BOARDS);
    });
  });

  describe('waking the Default copy', () => {
    function podService(): FakePodService {
      return app.get(PodService) as unknown as FakePodService;
    }

    function startupsOf(projectEnvironmentId: string): number {
      const podName = podService().assignedPodName(projectEnvironmentId);
      return podService()
        .callsTo('waitForReady')
        .filter((call) => call.args.podName === podName).length;
    }

    beforeEach(async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      await suspendServicePod(service.projectEnvironmentId);
    });

    it('wakes a sleeping copy and answers once it serves', async () => {
      const answer = resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });

      await waitFor(() => startupsOf(service.projectEnvironmentId) > 0);
      await startPod();
      podService().markPodReady(podService().assignedPodName(service.projectEnvironmentId), '127.0.0.1');
      await waitFor(async () => (await serviceEnvironmentRow(service.projectEnvironmentId))?.status === 'active');
      app.get(AppReadinessService).markServing(service.projectEnvironmentId);
      const res = await answer;

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().upstream).toBe(`http://127.0.0.1:${podPort}`);
    });

    it('answers 504 when the copy is not ready within the hold', async () => {
      const res = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });

      expect(res.statusCode, res.body).toBe(504);
      expect(res.json()).toEqual({ message: 'Fixture Boards did not start in time; retry shortly.' });
      expect(startupsOf(service.projectEnvironmentId)).toBeGreaterThan(0);
    });
  });
});

async function storeRawProjectConfiguration(
  serviceId: string,
  projectEnvironmentId: string,
  values: Record<string, JsonValue>
): Promise<void> {
  await db
    .insert(externalServiceProjectConfigs)
    .values({ id: crypto.randomUUID(), externalServiceId: serviceId, projectEnvironmentId, values });
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { Perms } from '../../src/permission/permission.constants';
import { PodService } from '../../src/pod/pod.service';
import { ProjectController } from '../../src/project/project.controller';
import type { FakePodService } from '../support/infra-fakes';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import {
  callAsGate,
  gatewayUrlOf,
  resolveCaller,
  resolved,
  startGateControl,
  type GateControl,
} from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import {
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';
import { SDK2_BOARDS_MANIFEST, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';

const PUBLIC_URL = 'https://opsiforce.example.com';
const START_HOLD_MS = 1_500;
const READY_SDK2_BOARDS = { apiToken: 'boards-api-token-1', region: 'eu' };

@Module({ controllers: [ProjectController] })
class ProjectRoutes {}

describe('the brakes on an SDK 2 service', () => {
  let control: GateControl;
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
    control = await startGateControl();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-brakes-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: {
        OPSIFORCE_PUBLIC_URL: PUBLIC_URL,
        STORAGE_MOUNT_PATH: storageRoot,
        EXTERNAL_SERVICE_PROXY_CONTROL: control.address,
      },
      servicePodPort: podPort,
      serviceStartHoldMs: START_HOLD_MS,
      extraModules: [ProjectRoutes],
    });
    app = harness.app;
    backendUrl = await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await control.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pods = [];
    control.evictions.length = 0;
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: SDK2_BOARDS_MANIFEST });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_SDK2_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
  });

  afterEach(async () => {
    for (const pod of pods) await pod.close();
  });

  async function startPod(): Promise<Sdk2ServicePod> {
    const pod = await startSdk2ServicePod({
      gatewayKey: service.key,
      gatewayUrl: gatewayUrlOf(backendUrl),
      port: podPort,
    });
    pods.push(pod);
    return pod;
  }

  function fakePods(): FakePodService {
    return app.get(PodService) as unknown as FakePodService;
  }

  function controlToken(): string {
    return app.get(ConfigService).getOrThrow<string>('proxyControlToken');
  }

  describe('Disable', () => {
    it("refuses the next call with 404, evicts the Gate's cache for the service and deletes its pods", async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      expect((await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' })).statusCode).toBe(200);
      const deletedBefore = fakePods().callsTo('deletePod').length;

      const disabled = await app.inject({
        method: 'POST',
        url: `${TENANT_SERVICES}/${service.id}/disable`,
        headers: admin.headers,
      });

      expect(disabled.statusCode, disabled.body).toBe(200);
      const res = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ message: 'Fixture Boards is turned off in this Organization.' });
      expect(control.evictions).toContainEqual({
        token: controlToken(),
        target: { tenantId: admin.tenant.tenantId, slug: 'boards' },
      });
      expect(
        fakePods()
          .callsTo('deletePod')
          .slice(deletedBefore)
          .map((call) => call.args.podName)
      ).toContain(fakePods().assignedPodName(service.projectEnvironmentId));
    });

    it("evicts the Gate's cache for the service when its builder Project is disabled from the Project routes", async () => {
      expect((await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' })).statusCode).toBe(200);
      const operator = await addMember(app, admin.tenant, [Perms.disableProject, Perms.manageTenantExternalServices]);

      const disabled = await app.inject({
        method: 'POST',
        url: `/api/projects/${service.builderChatId}/disable`,
        headers: operator.headers,
      });

      expect(disabled.statusCode, disabled.body).toBe(201);
      const res = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });
      expect(res.statusCode).toBe(404);
      expect(control.evictions).toContainEqual({
        token: controlToken(),
        target: { tenantId: admin.tenant.tenantId, slug: 'boards' },
      });
    });
  });

  describe('Disconnect', () => {
    function projectDialogUrl(caller: GateCallerFixture): string {
      return `/api/external-services/projects/${caller.projectId}/environments/${caller.projectEnvironmentId}/services/${service.id}/configuration`;
    }

    function servicePageUrl(caller: GateCallerFixture): string {
      return `${TENANT_SERVICES}/${service.id}/consumers/${caller.projectEnvironmentId}`;
    }

    async function callCards(): Promise<Response> {
      return callAsGate(await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }), '/cards');
    }

    it('from the Project dialog deletes the configuration, tells the service and the next call is not connected', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const pod = await startPod();
      expect((await callCards()).status).toBe(200);
      const configurer = await addMember(app, admin.tenant, [Perms.configureProjectExternalServices]);

      const res = await app.inject({ method: 'DELETE', url: projectDialogUrl(consumer), headers: configurer.headers });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().projectConfiguration.saved).toBe(false);
      expect(pod.hooks).toEqual([
        expect.objectContaining({
          hook: 'onProjectConfigurationSaved',
          previous: { boardIds: ['b1'] },
          current: null,
          projectConfiguration: null,
        }),
      ]);
      const refused = await callCards();
      expect(refused.status).toBe(403);
      expect(refused.headers.get('opsiforce-outcome')).toBe('not connected');
    });

    it('from the service page lets an Organization admin cut off one consuming Project', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const other = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, other, 'boards', { boardIds: ['b2'] });
      const pod = await startPod();

      const res = await app.inject({ method: 'DELETE', url: servicePageUrl(consumer), headers: admin.headers });

      expect(res.statusCode, res.body).toBe(204);
      const consumers = await app.inject({
        method: 'GET',
        url: `${TENANT_SERVICES}/${service.id}/consumers`,
        headers: admin.headers,
      });
      expect(consumers.json().map((entry: { projectEnvironmentId: string }) => entry.projectEnvironmentId)).toEqual([
        other.projectEnvironmentId,
      ]);
      expect(
        pod.hooks.map(({ caller, current }) => ({ projectEnvironmentId: caller.projectEnvironmentId, current }))
      ).toEqual([{ projectEnvironmentId: consumer.projectEnvironmentId, current: null }]);
      expect((await callCards()).headers.get('opsiforce-outcome')).toBe('not connected');
    });

    it('lets an Organization admin Disconnect from the Project dialog too', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });

      const res = await app.inject({ method: 'DELETE', url: projectDialogUrl(consumer), headers: admin.headers });

      expect(res.statusCode, res.body).toBe(200);
    });

    it('refuses someone who may neither configure the Project nor manage the service', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const member = await addMember(app, admin.tenant, [Perms.usePublicApi]);

      const fromDialog = await app.inject({
        method: 'DELETE',
        url: projectDialogUrl(consumer),
        headers: member.headers,
      });
      const fromPage = await app.inject({ method: 'DELETE', url: servicePageUrl(consumer), headers: member.headers });

      expect(fromDialog.statusCode).toBe(403);
      expect(fromPage.statusCode).toBe(403);
      await startPod();
      expect((await callCards()).status).toBe(200);
    });
  });

  describe('Rotate Gateway Key', () => {
    function rotateUrl(projectId: string, projectEnvironmentId: string): string {
      return `/api/projects/${projectId}/environments/${projectEnvironmentId}/gateway-key/rotate`;
    }

    it('revokes the old key at once, the new key resolves, the Gate forgets the old one and the pod restarts', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const editor = await addMember(app, admin.tenant, [Perms.usePublicApi]);
      const deletedBefore = fakePods().callsTo('deletePod').length;

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(consumer.projectId, consumer.projectEnvironmentId),
        headers: editor.headers,
      });

      expect(res.statusCode, res.body).toBe(204);
      const rotated = await app.get(GatewayKeyService).getEnvironmentToken(consumer.projectEnvironmentId);
      expect(rotated).toMatch(/^gw-/);
      expect(rotated).not.toBe(consumer.key);
      const old = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });
      expect(old.statusCode).toBe(401);
      expect(old.json().message).toMatch(/unknown or revoked/);
      expect((await resolveCaller(app, { credential: `Bearer ${rotated}`, slug: 'boards' })).statusCode).toBe(200);
      expect(control.evictions).toEqual([{ token: controlToken(), target: { gatewayKey: consumer.key } }]);
      expect(
        fakePods()
          .callsTo('deletePod')
          .slice(deletedBefore)
          .map((call) => call.args.podName)
      ).toContain(fakePods().assignedPodName(consumer.projectEnvironmentId));
    });

    it("also evicts the service's cached callers when the rotated key is the service pod's own", async () => {
      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(service.builderChatId, service.projectEnvironmentId),
        headers: admin.headers,
      });

      expect(res.statusCode, res.body).toBe(204);
      expect(control.evictions.map((eviction) => eviction.target)).toEqual(
        expect.arrayContaining([{ gatewayKey: service.key }, { tenantId: admin.tenant.tenantId, slug: 'boards' }])
      );
    });

    it('refuses someone outside the Organization', async () => {
      const stranger = await tenantAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: rotateUrl(consumer.projectId, consumer.projectEnvironmentId),
        headers: stranger.headers,
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(403);
      expect(await app.get(GatewayKeyService).getEnvironmentToken(consumer.projectEnvironmentId)).toBe(consumer.key);
    });
  });

  describe("a disabled Project's key", () => {
    it('is refused with 401 and forgotten by the Gate', async () => {
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const operator = await addMember(app, admin.tenant, [Perms.disableProject]);

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${consumer.projectId}/disable`,
        headers: operator.headers,
      });

      expect(res.statusCode, res.body).toBe(201);
      const refused = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().message).toMatch(/Project is disabled/);
      expect(control.evictions).toContainEqual({ token: controlToken(), target: { gatewayKey: consumer.key } });
    });
  });
});

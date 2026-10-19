import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  computeManifestHash,
  createFileServiceRecords,
  recordsFileInWorkspace,
  stateFileInWorkspace,
  type CallLogOutcome,
  type CallRow,
} from '@opsiforce/external-service-sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ensureBuiltInAgent } from '../support/agent-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { gatewayUrlOf } from './support/gate-proxy';
import { consumerIn, freePort, publishCustomService, type PublishedService } from './support/published-services';
import { revealed, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';
import { committedWorkspace, publishReview, writeTestReport } from './support/service-publishing';
import {
  builderLane,
  runningDevelopment,
  saveDevelopmentConfiguration,
  type BuilderDevelopment,
} from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';

const EXTERNAL_SERVICES_HOST = 'external-services.opsiforce.example.com';

const LANE_MANIFEST = {
  sdk: 2,
  displayName: 'Fixture Boards',
  description: 'A pretend board tool the builder is still building.',
  inbound: true,
  events: { 'card.created': { title: 'Card created', description: 'Someone created a card on a board.' } },
  serviceForm: [
    { key: 'apiToken', type: 'secret', label: 'API token', required: true },
    { key: 'region', type: 'text', label: 'Region' },
    { key: 'showQr', type: 'button', label: 'Show QR code', call: 'showQr' },
  ],
  projectForm: [
    { key: 'boardIds', type: 'multiselect', label: 'Boards', required: true, options: { call: 'boards' } },
    { key: 'signingSecret', type: 'secret', label: 'Signing secret' },
  ],
} as const;

const READY = { apiToken: 'boards-dev-token', region: 'eu' };

function usageRows(recordsFile: string): unknown[] {
  const database = new DatabaseSync(recordsFile, { readOnly: true });
  try {
    return database
      .prepare('SELECT name, project_environment_id, value FROM usage ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

describe("the External Service Builder's lane on the gateway", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let development: BuilderDevelopment;
  let pod: Sdk2ServicePod | undefined;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-builder-lane-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: {
        OPSIFORCE_PUBLIC_URL: PUBLIC_URL,
        STORAGE_MOUNT_PATH: storageRoot,
        EXTERNAL_SERVICES_HOST,
      },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_500,
    });
    app = harness.app;
    backendUrl = await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: LANE_MANIFEST });
    development = await runningDevelopment(app, storageRoot, service.builderChatId, LANE_MANIFEST);
  });

  afterEach(async () => {
    await pod?.close();
    pod = undefined;
  });

  async function createTestProject() {
    const agentId = await ensureBuiltInAgent('app-builder');
    const res = await builderLane(app, development.key, {
      method: 'POST',
      path: '/test-project',
      payload: { agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; projectEnvironmentId: string }>();
  }

  describe('GET /_builder', () => {
    it("tells the builder the Service host, Development's Webhook address and the missing required fields", async () => {
      const res = await builderLane(app, development.key, {});

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        service: { id: service.id, slug: 'boards', serviceHost: `https://boards.${EXTERNAL_SERVICES_HOST}` },
        development: {
          webhookUrl: `${PUBLIC_URL}/api/external-services/webhooks/${service.id}/development`,
          servable: true,
          serviceConfiguration: { saved: false, missing: ['apiToken'] },
        },
        testProject: null,
      });
    });

    it("shows Development's saved Service configuration with its secrets masked, so the builder reads an address before writing code", async () => {
      expect((await saveDevelopmentConfiguration(app, admin, service.id, READY)).statusCode).toBe(200);

      const view = (await builderLane(app, development.key, {})).json();

      expect(view.development.serviceConfiguration).toEqual({
        saved: true,
        values: { apiToken: { stored: true }, region: 'eu' },
        missing: [],
      });
    });

    it("names the Test Project's Gateway Key once it exists, so the builder can call Development as that Project", async () => {
      const testProject = await createTestProject();

      const view = (await builderLane(app, development.key, {})).json();

      const key = await app.get(GatewayKeyService).getEnvironmentToken(testProject.projectEnvironmentId);
      expect(key).toMatch(/^gw-/);
      expect(view.testProject).toMatchObject({
        id: testProject.id,
        projectEnvironmentId: testProject.projectEnvironmentId,
        gatewayKey: key,
      });
    });

    it("answers only the builder chat's own Development pod", async () => {
      const testProject = await createTestProject();
      const testProjectKey = await app.get(GatewayKeyService).getEnvironmentToken(testProject.projectEnvironmentId);
      const consumer = await consumerIn(app, admin.tenant);

      const anonymous = await builderLane(app, null, {});
      const asTestProject = await builderLane(app, testProjectKey, {});
      const asConsumer = await builderLane(app, consumer.key, {});
      const asDefault = await builderLane(app, service.key, {});

      expect(anonymous.statusCode).toBe(401);
      expect(asTestProject.statusCode).toBe(403);
      expect(asConsumer.statusCode).toBe(403);
      expect(asDefault.statusCode).toBe(403);
    });
  });

  describe('the Test Project configuration', () => {
    it('reads and saves values alone, with no operations map', async () => {
      await createTestProject();

      const saved = await builderLane(app, development.key, {
        method: 'PUT',
        path: '/test-project/configuration',
        payload: { values: { boardIds: ['b1'], signingSecret: 'test-signing-secret' } },
      });
      const read = await builderLane(app, development.key, { path: '/test-project/configuration' });

      expect(saved.statusCode, saved.body).toBe(200);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toEqual({
        service: 'boards',
        projectConfiguration: {
          saved: true,
          values: { boardIds: ['b1'], signingSecret: { stored: true } },
          missing: [],
        },
      });
    });
  });

  describe('Test Project reset', () => {
    it("wipes Development's ctx.state and the Test Project's Events and keeps Development's records file", async () => {
      const testProject = await createTestProject();
      const developmentFolder = join(storageRoot, development.directory);
      const stateFile = join(developmentFolder, stateFileInWorkspace);
      const recordsFile = join(developmentFolder, recordsFileInWorkspace);
      pod = await startSdk2ServicePod({
        gatewayKey: development.key,
        gatewayUrl: gatewayUrlOf(backendUrl),
        port: podPort,
        manifest: LANE_MANIFEST,
        stateFile,
        recordsFile,
      });
      expect((await saveDevelopmentConfiguration(app, admin, service.id, READY)).statusCode).toBe(200);
      const connected = await builderLane(app, development.key, {
        method: 'PUT',
        path: '/test-project/configuration',
        payload: { values: { boardIds: ['b1'] } },
      });
      expect(connected.statusCode, connected.body).toBe(200);
      await pod.service.state.set('last-card', 'c-1');
      const [delivered] = await pod.service.deliver(
        { type: 'card.created', key: 'c-1', occurredAt: '2026-10-17T09:30:00.000Z', data: { card: 'c-1' } },
        { to: [testProject.projectEnvironmentId] }
      );
      expect(delivered).toMatchObject({ result: 'stored' });
      pod.flushRecords();
      const eventsBefore = await builderLane(app, development.key, { path: '/test-project/events' });
      expect(eventsBefore.json().events).toHaveLength(1);
      expect(existsSync(stateFile)).toBe(true);
      await pod.close();
      pod = undefined;

      const res = await builderLane(app, development.key, { method: 'POST', path: '/test-project/reset' });

      expect(res.statusCode, res.body).toBe(204);
      const eventsAfter = await builderLane(app, development.key, { path: '/test-project/events' });
      expect(eventsAfter.json()).toEqual({ events: [] });
      expect(existsSync(stateFile)).toBe(false);
      expect(usageRows(recordsFile)).toEqual([
        { name: 'events', project_environment_id: testProject.projectEnvironmentId, value: 1 },
      ]);
    });
  });

  describe('the test report', () => {
    function callRow(requestId: string, outcome: CallLogOutcome): CallRow {
      return {
        requestId,
        time: new Date().toISOString(),
        callerKind: 'call',
        projectId: service.builderChatId,
        projectEnvironmentId: development.projectEnvironmentId,
        environment: 'development',
        method: 'GET',
        path: '/boards',
        route: 'List boards',
        outcome,
        reason: outcome === 'proxied' ? null : 'Boards needs the board in Boards',
        status: outcome === 'proxied' ? 200 : 403,
        bytesIn: 0,
        bytesOut: 2,
        durationMs: 3,
        notes: {},
      };
    }

    async function reviewCiting(callIds: string[]) {
      const workspace = join(storageRoot, development.directory);
      const records = createFileServiceRecords({ file: join(workspace, recordsFileInWorkspace) });
      records.call(callRow('req-proxied', 'proxied'));
      records.call(callRow('req-refused', 'not allowed'));
      records.close();
      const commit = await committedWorkspace(workspace);
      await writeTestReport(workspace, {
        commit,
        manifestHash: computeManifestHash(LANE_MANIFEST),
        lines: [{ expectation: 'gh lists the boards', result: 'pass', source: 'live-call', callIds }],
      });
      const res = await publishReview(app, admin, service.id, service.environmentId);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    }

    it("reads call ids as request ids in Development's records file, so a proxied request proves the upstream was called", async () => {
      const review = await reviewCiting(['req-proxied', 'req-unknown']);

      expect(review.testWarnings).toEqual([]);
      expect(review.testReport).toMatchObject({
        state: 'present',
        upstreamCalled: true,
        unknownCallIds: ['req-unknown'],
      });
    });

    it('warns that the upstream was never called when every cited request was refused', async () => {
      const review = await reviewCiting(['req-refused']);

      expect(review.testWarnings.map((warning: { code: string }) => warning.code)).toEqual(['upstream-never-called']);
      expect(review.testReport).toMatchObject({ upstreamCalled: false, unknownCallIds: [] });
    });
  });

  describe('probes', () => {
    let seen: { handler: string; draft: unknown; caller: unknown; serviceConfiguration: unknown }[];

    beforeEach(async () => {
      seen = [];
      pod = await startSdk2ServicePod({
        gatewayKey: development.key,
        gatewayUrl: gatewayUrlOf(backendUrl),
        port: podPort,
        manifest: LANE_MANIFEST,
        handlers: {
          options: {
            boards: (draft, ctx) => {
              seen.push({
                handler: 'options.boards',
                draft: revealed(draft),
                caller: ctx.caller,
                serviceConfiguration: revealed(ctx.serviceConfiguration),
              });
              return [{ value: 'b1', label: 'Roadmap' }];
            },
          },
          buttons: {
            showQr: (draft, ctx) => {
              seen.push({
                handler: 'buttons.showQr',
                draft: revealed(draft),
                caller: ctx.caller,
                serviceConfiguration: revealed(ctx.serviceConfiguration),
              });
              return { message: 'Scan the code', level: 'info' };
            },
          },
        },
      });
      const configured = await saveDevelopmentConfiguration(app, admin, service.id, READY);
      expect(configured.statusCode, configured.body).toBe(200);
    });

    it("runs a Project-form handler as platform for the Test Project's ProjectEnvironment", async () => {
      const testProject = await createTestProject();

      const res = await builderLane(app, development.key, {
        method: 'POST',
        path: '/probe/options/boards',
        payload: { values: { boardIds: [] }, query: 'road' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([{ value: 'b1', label: 'Roadmap' }]);
      expect(seen).toEqual([
        {
          handler: 'options.boards',
          draft: { form: 'projectForm', values: { boardIds: [] }, query: 'road' },
          caller: expect.objectContaining({
            kind: 'platform',
            tenantId: admin.tenant.tenantId,
            projectEnvironmentId: testProject.projectEnvironmentId,
          }),
          serviceConfiguration: READY,
        },
      ]);
    });

    it("runs a Service-form handler as platform naming no ProjectEnvironment, on Development's Service configuration", async () => {
      const res = await builderLane(app, development.key, {
        method: 'POST',
        path: '/probe/service/buttons/showQr',
        payload: {},
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ message: 'Scan the code', level: 'info' });
      expect(seen).toEqual([
        {
          handler: 'buttons.showQr',
          draft: { form: 'serviceForm', values: READY },
          caller: { kind: 'platform', tenantId: admin.tenant.tenantId },
          serviceConfiguration: READY,
        },
      ]);
    });

    it('lets the builder try a Service-form value over the saved one', async () => {
      const res = await builderLane(app, development.key, {
        method: 'POST',
        path: '/probe/service/buttons/showQr',
        payload: { values: { region: 'us' } },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(seen[0]?.draft).toEqual({ form: 'serviceForm', values: { ...READY, region: 'us' } });
    });

    it('refuses a name no field of the form calls', async () => {
      const res = await builderLane(app, development.key, {
        method: 'POST',
        path: '/probe/service/buttons/nothing',
        payload: {},
      });

      expect(res.statusCode, res.body).toBe(404);
      expect(seen).toEqual([]);
    });

    it('no longer describes the service, lists its OpenAPI or recent calls, or calls Operations', async () => {
      await createTestProject();

      const answers = await Promise.all([
        builderLane(app, development.key, { path: '/probe' }),
        builderLane(app, development.key, { path: '/probe/openapi.json' }),
        builderLane(app, development.key, { path: '/probe/calls' }),
        builderLane(app, development.key, { method: 'POST', path: '/probe/list_boards', payload: {} }),
      ]);

      expect(answers.map((answer) => answer.statusCode)).toEqual([404, 404, 404, 404]);
    });
  });
});

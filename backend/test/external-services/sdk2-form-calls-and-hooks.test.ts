import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Secret } from '@opsiforce/external-service-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigurationCarry } from '../../src/external-services/configuration/project-configuration-carry';
import { ExternalServicesProjectLifecycle } from '../../src/external-services/external-services-project-lifecycle';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { gatewayUrlOf } from './support/gate-proxy';
import { productionCaller } from './support/gate';
import { projectServiceUrl, saveProjectService, type ConfiguringProject } from './support/generating';
import {
  consumerIn,
  freePort,
  publishCustomService,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';
import {
  revealed,
  startSdk2ServicePod,
  type Sdk2PodHandlers,
  type Sdk2PodHook,
  type Sdk2ServicePod,
} from './support/sdk2-service-pod';
import {
  builderLane,
  createTestProject,
  runningDevelopment,
  saveDevelopmentConfiguration,
  saveTestProjectConfiguration,
  type BuilderDevelopment,
} from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';

const FORMS_MANIFEST = {
  sdk: 2,
  displayName: 'Fixture Boards',
  description: 'A pretend board tool with forms that ask the service.',
  serviceForm: [
    { key: 'apiToken', type: 'secret', label: 'API token', required: true },
    { key: 'region', type: 'text', label: 'Region' },
    { key: 'testConnection', type: 'button', label: 'Test connection', call: 'testConnection' },
    { key: 'workspaces', type: 'list', label: 'Workspaces', item: [{ key: 'label', type: 'text', required: true }] },
  ],
  projectForm: [
    { key: 'boardIds', type: 'multiselect', label: 'Boards', options: { call: 'boards' } },
    { key: 'mode', type: 'radio', label: 'Mode', options: { call: 'modes' } },
    {
      key: 'workspace',
      type: 'select',
      label: 'Workspace',
      options: { serviceConfiguration: 'workspaces', labelKey: 'label' },
    },
    { key: 'summary', type: 'info', label: 'Summary', call: 'summary' },
    { key: 'preview', type: 'button', label: 'Preview', call: 'preview' },
    { key: 'signingSecret', type: 'secret', label: 'Signing secret' },
  ],
} as const;

const READY = { apiToken: 'boards-api-token-1', region: 'eu' };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

interface FormCallSeen {
  handler: string;
  draft: unknown;
  caller: unknown;
  serviceConfiguration: unknown;
  projectConfiguration: unknown;
  saved?: unknown;
}

function reveal(secret: unknown): string {
  return secret instanceof Secret ? secret.reveal() : String(secret);
}

describe('form calls and save hooks of an SDK 2 service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let project: ConfiguringProject;
  let pod: Sdk2ServicePod | undefined;
  let formCalls: FormCallSeen[];

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-form-calls-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
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
    formCalls = [];
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: FORMS_MANIFEST });
    const consumer = await consumerIn(app, admin.tenant);
    project = {
      ...consumer,
      configurer: await addMember(app, consumer.tenant, ['can_configure_project_external_services']),
    };
  });

  afterEach(async () => {
    await pod?.close();
    pod = undefined;
  });

  function seen(
    handler: string,
    draft: unknown,
    ctx: Parameters<NonNullable<Sdk2PodHandlers['info']>[string]>[1],
    saved?: unknown
  ) {
    formCalls.push({
      handler,
      draft: revealed(draft),
      caller: ctx.caller,
      serviceConfiguration: revealed(ctx.serviceConfiguration),
      projectConfiguration: revealed(ctx.projectConfiguration),
      ...(saved === undefined ? {} : { saved }),
    });
  }

  const recordingHandlers: Sdk2PodHandlers = {
    options: {
      boards: (draft, ctx) => {
        seen('options.boards', draft, ctx);
        return [
          { value: 'b1', label: 'Roadmap' },
          { value: 'b2', label: 'Operations' },
        ];
      },
      modes: () => [
        { value: 'all', label: 'All boards' },
        { value: 'picked', label: 'Picked boards' },
      ],
    },
    info: {
      summary: (draft, ctx) => {
        seen('info.summary', draft, ctx);
        return { text: 'Two boards' };
      },
    },
    buttons: {
      testConnection: async (draft, ctx) => {
        seen('buttons.testConnection', draft, ctx, revealed(await ctx.service.configuration()));
        return {
          message: `Connected with ${reveal(ctx.serviceConfiguration.apiToken).slice(0, 5)}…`,
          level: 'success',
        };
      },
    },
  };

  async function startPod(
    options: { handlers?: Sdk2PodHandlers; hooksDeclared?: boolean; gatewayKey?: string } = {}
  ): Promise<Sdk2ServicePod> {
    await pod?.close();
    pod = await startSdk2ServicePod({
      gatewayKey: options.gatewayKey ?? service.key,
      gatewayUrl: gatewayUrlOf(backendUrl),
      port: podPort,
      manifest: FORMS_MANIFEST,
      handlers: options.handlers ?? recordingHandlers,
      ...(options.hooksDeclared === undefined ? {} : { hooksDeclared: options.hooksDeclared }),
    });
    return pod;
  }

  function projectFormCall(route: string, name: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `${projectServiceUrl(project, service.id)}/${route}/${name}`,
      headers: project.configurer.headers,
      payload,
    });
  }

  function serviceFormCall(route: string, name: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `${TENANT_SERVICES}/${service.id}/${route}/${name}`,
      headers: admin.headers,
      payload,
    });
  }

  async function saveService(values: Record<string, unknown>) {
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, values);
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json();
  }

  async function saveProject(values: Record<string, unknown>) {
    const saved = await saveProjectService(app, project, service.id, values);
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json();
  }

  function hooksNamed(hook: Sdk2PodHook['hook']): Sdk2PodHook[] {
    return (pod?.hooks ?? []).filter((entry) => entry.hook === hook);
  }

  describe('Project-form calls', () => {
    beforeEach(async () => {
      await startPod();
      await saveService(READY);
      await saveProject({ boardIds: ['b1'], signingSecret: 'stored-signing-secret' });
    });

    it('run the named handler on the draft merged with stored secrets, beside the saved configurations', async () => {
      const res = await projectFormCall('options', 'boards', {
        values: { boardIds: ['b2'], signingSecret: { stored: true } },
        query: 'ro',
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([
        { value: 'b1', label: 'Roadmap' },
        { value: 'b2', label: 'Operations' },
      ]);
      expect(formCalls).toEqual([
        {
          handler: 'options.boards',
          draft: {
            form: 'projectForm',
            values: { boardIds: ['b2'], signingSecret: 'stored-signing-secret' },
            query: 'ro',
          },
          caller: {
            kind: 'platform',
            tenantId: admin.tenant.tenantId,
            projectId: project.projectId,
            projectEnvironmentId: project.projectEnvironmentId,
            environment: expect.any(String),
          },
          serviceConfiguration: READY,
          projectConfiguration: { boardIds: ['b1'], signingSecret: 'stored-signing-secret' },
        },
      ]);
    });

    it('answer an info field and never hand a stored secret to the browser', async () => {
      const res = await projectFormCall('info', 'summary', { values: { signingSecret: { stored: true } } });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ text: 'Two boards' });
      expect(res.body).not.toContain('stored-signing-secret');
    });

    it('call the service for a radio whose options come from a call', async () => {
      const res = await projectFormCall('options', 'modes', { values: {} });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([
        { value: 'all', label: 'All boards' },
        { value: 'picked', label: 'Picked boards' },
      ]);
    });

    it("pass a handler's failure on as a problem the dialog can show", async () => {
      await startPod({
        handlers: {
          buttons: {
            preview: () => {
              throw new Error('the board tool is down');
            },
          },
        },
      });

      const res = await projectFormCall('buttons', 'preview', { values: {} });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'service-failed',
        detail: expect.stringMatching(
          / couldn't do this\. Try again; if it keeps failing, an Organization admin can check this service's Calls\.$/
        ),
      });
      expect(res.body).not.toContain('preview');
      expect(res.body).not.toContain('the board tool is down');
    });
  });

  describe('Service-form calls', () => {
    it('test the values just typed, while service.configuration() stays the saved copy', async () => {
      await startPod();
      await saveService(READY);

      const res = await serviceFormCall('buttons', 'testConnection', {
        values: { apiToken: 'typed-api-token-2', region: 'us' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ message: 'Connected with typed…', level: 'success' });
      expect(formCalls).toEqual([
        {
          handler: 'buttons.testConnection',
          draft: { form: 'serviceForm', values: { apiToken: 'typed-api-token-2', region: 'us' } },
          caller: { kind: 'platform', tenantId: admin.tenant.tenantId },
          serviceConfiguration: { apiToken: 'typed-api-token-2', region: 'us' },
          projectConfiguration: null,
          saved: READY,
        },
      ]);
    });

    it('merge the stored secret into a blank secret box before the first test', async () => {
      await startPod();
      await saveService(READY);

      const res = await serviceFormCall('buttons', 'testConnection', {
        values: { apiToken: { stored: true }, region: 'us' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(formCalls[0]?.serviceConfiguration).toEqual({ apiToken: READY.apiToken, region: 'us' });
    });
  });

  describe('answer caps', () => {
    beforeEach(async () => {
      await saveService(READY);
    });

    async function answering(answer: unknown, route: 'options' | 'buttons' = 'buttons') {
      await startPod({
        handlers:
          route === 'options'
            ? { options: { boards: () => answer as never } }
            : { buttons: { preview: () => answer as never } },
      });
      return projectFormCall(route, route === 'options' ? 'boards' : 'preview', { values: {} });
    }

    it('keep the first 50 options', async () => {
      const options = Array.from({ length: 60 }, (_, index) => ({ value: `b${index}`, label: `Board ${index}` }));

      const res = await answering(options, 'options');

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(options.slice(0, 50));
    });

    it('pass a png image through, encoded afresh', async () => {
      const res = await answering({
        image: { mimeType: 'image/png', base64: PNG.toString('base64') },
        caption: 'Board',
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        image: { mimeType: 'image/png', base64: PNG.toString('base64') },
        caption: 'Board',
      });
    });

    it.each([
      ['an svg image', { image: { mimeType: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') } }],
      [
        'bytes that are not the image type they claim',
        { image: { mimeType: 'image/png', base64: Buffer.from('GIF89a....').toString('base64') } },
      ],
      [
        'an image over 1 MB',
        {
          image: { mimeType: 'image/png', base64: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]).toString('base64') },
        },
      ],
      ['a link that is not http(s)', { link: 'javascript:alert(1)' }],
    ])('refuse %s', async (_case, answer) => {
      const res = await answering(answer);

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'service-failed' });
    });

    it('refuse an answer over 2 MB', async () => {
      const res = await answering({ message: 'x'.repeat(2 * 1024 * 1024 + 1) });

      expect(res.statusCode, res.body).toBe(502);
    });
  });

  describe('onServiceConfigurationSaved', () => {
    it('runs after every save with the change and a platform identity naming no ProjectEnvironment', async () => {
      await startPod();

      const first = await saveService(READY);
      const second = await saveService({ ...READY, apiToken: { stored: true }, region: 'us' });

      expect(first.hookFailure).toBeNull();
      expect(second.hookFailure).toBeNull();
      expect(hooksNamed('onServiceConfigurationSaved')).toEqual([
        expect.objectContaining({
          previous: null,
          current: READY,
          caller: { kind: 'platform', tenantId: admin.tenant.tenantId },
          serviceConfiguration: READY,
        }),
        expect.objectContaining({
          previous: READY,
          current: { ...READY, region: 'us' },
          serviceConfiguration: { ...READY, region: 'us' },
        }),
      ]);
    });

    it('is answered 204 by a service that declares no hook, which counts as done', async () => {
      await startPod({ hooksDeclared: false });

      const saved = await saveService(READY);

      expect(saved.hookFailure).toBeNull();
    });

    it("keeps the save and shows the hook's failure for Retry when the hook throws", async () => {
      let failing = true;
      await startPod({
        handlers: {
          hooks: {
            onServiceConfigurationSaved: () => {
              if (failing) throw new Error('the board tool is down');
            },
          },
        },
      });

      const saved = await saveService(READY);
      failing = false;
      const retried = await app.inject({
        method: 'POST',
        url: `${TENANT_SERVICES}/${service.id}/configuration/hook/retry`,
        headers: admin.headers,
      });

      expect(saved.hookFailure).toMatchObject({ code: 'service-failed' });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().hookFailure).toBeNull();
    });
  });

  describe('onProjectConfigurationSaved', () => {
    beforeEach(async () => {
      await startPod();
      await saveService({ ...READY, workspaces: [{ label: 'North' }, { label: 'South' }] });
    });

    function projectHooks(): Sdk2PodHook[] {
      return hooksNamed('onProjectConfigurationSaved');
    }

    it('runs on a save, naming the ProjectEnvironment, and the service reads the new configuration at once', async () => {
      await saveProject({ boardIds: ['b1'] });
      await saveProject({ boardIds: ['b2'] });

      expect(projectHooks()).toEqual([
        expect.objectContaining({
          previous: null,
          current: { boardIds: ['b1'] },
          caller: expect.objectContaining({ kind: 'platform', projectEnvironmentId: project.projectEnvironmentId }),
          projectConfiguration: { boardIds: ['b1'] },
        }),
        expect.objectContaining({
          previous: { boardIds: ['b1'] },
          current: { boardIds: ['b2'] },
          projectConfiguration: { boardIds: ['b2'] },
        }),
      ]);
    });

    it('runs when a Service-configuration save removes a list item the Project configuration picked', async () => {
      const workspaces = (
        await app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}`, headers: admin.headers })
      ).json().serviceConfiguration.values.workspaces as { id: string; label: string }[];
      const [north, south] = workspaces as unknown as [{ id: string }, { id: string }];
      await saveProject({ workspace: north.id });

      await saveService({ ...READY, apiToken: { stored: true }, workspaces: [south] });

      expect(projectHooks().at(-1)).toMatchObject({ previous: { workspace: north.id }, current: {} });
    });

    it('runs on a Publish carry into another environment of the Project', async () => {
      await saveProject({ boardIds: ['b1'] });
      const production = await productionCaller(app, project);

      await app.get(ProjectConfigurationCarry).carry(project.projectEnvironmentId, production.projectEnvironmentId);

      expect(projectHooks().at(-1)).toMatchObject({
        previous: null,
        current: { boardIds: ['b1'] },
        caller: { projectEnvironmentId: production.projectEnvironmentId },
      });
    });

    it('runs with current null when the environment is removed', async () => {
      await saveProject({ boardIds: ['b1'] });

      await app.get(ExternalServicesProjectLifecycle).environmentRemoving(project.projectEnvironmentId);

      expect(projectHooks().at(-1)).toMatchObject({ previous: { boardIds: ['b1'] }, current: null });
    });

    it('runs with current null for every consumer when the service is deleted', async () => {
      await saveProject({ boardIds: ['b1'] });

      const deleted = await app.inject({
        method: 'DELETE',
        url: `${TENANT_SERVICES}/${service.id}?confirmSlug=boards`,
        headers: admin.headers,
      });

      expect(deleted.statusCode, deleted.body).toBeLessThan(300);
      expect(projectHooks().at(-1)).toMatchObject({
        previous: { boardIds: ['b1'] },
        current: null,
        caller: { projectEnvironmentId: project.projectEnvironmentId },
      });
    });
  });

  describe('a Test Project reset', () => {
    let development: BuilderDevelopment;
    let developmentPod: Sdk2ServicePod;

    beforeEach(async () => {
      development = await runningDevelopment(app, storageRoot, service.builderChatId, FORMS_MANIFEST);
      developmentPod = await startPod({ gatewayKey: development.key });
      const saved = await saveDevelopmentConfiguration(app, admin, service.id, READY);
      expect(saved.statusCode, saved.body).toBe(200);
      await createTestProject(app, development.key);
      const configured = await saveTestProjectConfiguration(app, development.key, { boardIds: ['b2'] });
      expect(configured.statusCode, configured.body).toBe(200);
    });

    it("deregisters the Test Project and runs Development's Service-configuration hook around the wipe", async () => {
      developmentPod.hooks.length = 0;

      const res = await builderLane(app, development.key, { method: 'POST', path: '/test-project/reset' });

      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(developmentPod.hooks.map(({ hook, previous, current }) => ({ hook, previous, current }))).toEqual([
        { hook: 'onProjectConfigurationSaved', previous: { boardIds: ['b2'] }, current: null },
        { hook: 'onServiceConfigurationSaved', previous: READY, current: null },
        { hook: 'onServiceConfigurationSaved', previous: null, current: READY },
      ]);
    });
  });
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { manifestHeader } from '@opsiforce/external-service-sdk/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls } from '../../db/schema';
import { ServicePods } from '../../src/external-services/gate/service-pods';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { Perms } from '../../src/permission/permission.constants';
import { addMember, type MemberFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  tenantAdmin,
  platformOperator,
  storedPlatformServiceConfiguration,
  type PersonFixture,
} from './support/fixtures';
import {
  callRow,
  callRowsOf,
  configurePlatformService,
  dispatchToFakePod,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
  type ServicePodFixture,
} from './support/gate';

const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

type FormCallRoute = 'options' | 'info' | 'buttons';

describe('form calls from the Project configuration dialog', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let caller: GateCallerFixture;
  let configurer: MemberFixture;
  let support: string;
  let sales: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [support, sales] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [
      string,
      string,
    ];
    caller = await gateCaller(app);
    configurer = await addMember(app, caller.tenant, [Perms.configureProjectExternalServices]);
  });

  function formCall(
    route: FormCallRoute,
    name: string,
    payload: Record<string, unknown>,
    person: MemberFixture = configurer
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/external-services/projects/${caller.projectId}/environments/${caller.projectEnvironmentId}/services/${serviceId}/${route}/${name}`,
      headers: person.headers,
      payload,
    });
  }

  it('answers a live picker with the options the service returns for the query', async () => {
    const res = await formCall('options', 'listAccounts', { values: { mailbox: support }, query: 'glo' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ value: 'acc_2', label: 'Globex' }]);
  });

  it('writes one Call row of kind form with the editor as user, refusing nothing', async () => {
    await formCall('options', 'listAccounts', { values: { mailbox: support }, query: '' });

    const [row] = await callRowsOf(caller.projectEnvironmentId);
    expect(row).toMatchObject({
      kind: 'form',
      via: 'form',
      slug: FIXTURE_SERVICE,
      externalServiceId: serviceId,
      tenantId: caller.tenant.tenantId,
      projectId: caller.projectId,
      projectTitle: caller.projectTitle,
      projectEnvironmentId: caller.projectEnvironmentId,
      operation: 'listAccounts',
      operationKind: 'options',
      decision: 'allowed',
      status: 200,
      userId: configurer.userId,
      bounds: null,
    });
    expect(row?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers info and button results as the service shaped them', async () => {
    const info = await formCall('info', 'accountsSummary', {
      values: { mailbox: support, accountIds: ['acc_1', 'acc_2'] },
    });
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json()).toEqual({ text: '2 accounts picked', level: 'info' });

    const button = await formCall('buttons', 'sendInvite', { values: { mailbox: support } });
    expect(button.statusCode, button.body).toBe(200);
    expect(button.json()).toEqual({ link: 'https://invite.example.test/crm', label: 'Open the invite' });
  });

  it("gives a callback inside a list item that item's unsaved values", async () => {
    const res = await formCall('options', 'listMembers', {
      values: {
        mailbox: support,
        teams: [
          { id: 'new_red', team: 'red' },
          { id: 'new_blue', team: 'blue' },
        ],
      },
      item: 'new_blue',
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ value: 'blue_1', label: 'First blue member' }]);
  });

  it('refuses a list item callback without the item, or with an item the values do not hold', async () => {
    const values = { mailbox: support, teams: [{ id: 'new_red', team: 'red' }] };

    const withoutItem = await formCall('options', 'listMembers', { values });
    expect(withoutItem.statusCode).toBe(400);
    expect(withoutItem.headers['content-type']).toBe(PROBLEM_JSON);
    expect(withoutItem.json()).toMatchObject({ code: 'invalid-form-call' });

    const unknownItem = await formCall('options', 'listMembers', { values, item: 'new_gone' });
    expect(unknownItem.statusCode).toBe(400);
    expect(unknownItem.json()).toMatchObject({ code: 'unknown-item' });
    expect(await callRow(unknownItem.json().callId)).toMatchObject({
      kind: 'form',
      decision: 'refused',
      status: 400,
    });
  });

  it("answers 404 unknown-callback for a name no Project form field calls, the Service form's included", async () => {
    const unknown: [FormCallRoute, string][] = [
      ['options', 'listEverything'],
      ['buttons', 'testMailbox'],
      ['info', 'connectionStatus'],
      ['buttons', 'listAccounts'],
    ];
    for (const [route, name] of unknown) {
      const res = await formCall(route, name, { values: {} });
      expect(res.statusCode, `${route}/${name}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'unknown-callback' });
    }
  });

  it('answers 404 for a route that is not a form call', async () => {
    const res = await formCall('operations' as FormCallRoute, 'get_account', { values: {} });

    expect(res.statusCode).toBe(404);
  });

  it('lets only a holder of can_configure_project_external_services call, writing no row otherwise', async () => {
    const member = await addMember(app, caller.tenant, [Perms.usePublicApi]);

    const res = await formCall('options', 'listAccounts', { values: {} }, member);

    expect(res.statusCode).toBe(403);
    expect(await callRowsOf(caller.projectEnvironmentId)).toEqual([]);
  });

  it('answers 404 for a Project the editor cannot open', async () => {
    const other = await gateCaller(app);
    const outsider = await addMember(app, other.tenant, [Perms.configureProjectExternalServices]);

    const res = await formCall('options', 'listAccounts', { values: {} }, outsider);

    expect(res.statusCode).toBe(404);
  });

  describe('dispatched to a service pod', () => {
    let service: ServicePodFixture;

    beforeEach(async () => {
      service = await dispatchToFakePod(app, FIXTURE_SERVICE);
    });

    afterEach(async () => {
      await service.stop();
    });

    async function answeredByRawPod(contentType: string, body: string, call: () => Promise<{ statusCode: number }>) {
      const fixture = app.get(ServiceRegistry).bySlug(FIXTURE_SERVICE);
      if (!fixture) throw new Error('fixture-crm is not registered');
      const pod = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': contentType, [manifestHeader]: fixture.manifestHash });
        response.end(body);
      });
      await new Promise<void>((resolve) => pod.listen(0, '127.0.0.1', resolve));
      const stopServing = app.get(ServicePods).serve(fixture.id, {
        url: `http://127.0.0.1:${(pod.address() as AddressInfo).port}`,
        projectEnvironmentId: service.projectEnvironmentId,
      });
      try {
        return await call();
      } finally {
        stopServing();
        await new Promise((resolve) => pod.close(resolve));
      }
    }

    it('never hands the browser a page a pod answered, only the shapes a form can show', async () => {
      const res = (await answeredByRawPod('text/html', '<script>alert(document.cookie)</script>', () =>
        formCall('options', 'listAccounts', { values: { mailbox: support }, query: 'glo' })
      )) as Awaited<ReturnType<typeof formCall>>;

      expect(res.statusCode, res.body).toBe(502);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(res.json()).toMatchObject({ code: 'service-failed' });
      expect(res.body).not.toContain('<script>');
    });

    it('answers well-shaped options as JSON whatever content type the pod claimed', async () => {
      const res = (await answeredByRawPod('text/html', '[{"value":"acc_1","label":"Globex"}]', () =>
        formCall('options', 'listAccounts', { values: { mailbox: support }, query: 'glo' })
      )) as Awaited<ReturnType<typeof formCall>>;

      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.json()).toEqual([{ value: 'acc_1', label: 'Globex' }]);
    });

    it('merges the stored secret into a blank secret box and never answers it to the browser', async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        signingSecret: 'project-signing-secret',
      });

      const res = await formCall('info', 'accountsSummary', {
        values: { mailbox: sales, signingSecret: { stored: true }, accountIds: ['acc_9'], operations: {} },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('project-signing-secret');
      const [received] = service.pod.receivedFormCalls;
      expect(received).toMatchObject({
        route: 'info',
        name: 'accountsSummary',
        form: 'projectForm',
        values: { mailbox: sales, signingSecret: 'project-signing-secret', accountIds: ['acc_9'] },
        caller: {
          tenantId: caller.tenant.tenantId,
          projectId: caller.projectId,
          environmentId: caller.projectEnvironmentId,
          via: 'form',
        },
      });
      expect(Object.keys(received?.caller ?? {}).toSorted()).toEqual([
        'environment',
        'environmentId',
        'projectId',
        'tenantId',
        'via',
      ]);
      expect(received?.values).not.toHaveProperty('operations');
    });

    it('cuts the Service configuration to the items the unsaved values pick', async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox: support });

      await formCall('options', 'listAccounts', { values: { mailbox: sales }, query: 'ac' });

      const [received] = service.pod.receivedFormCalls;
      expect(received?.query).toBe('ac');
      expect(received?.serviceConfiguration).toMatchObject({
        apiKey: 'crm-key-1',
        mailboxes: [{ id: sales, label: 'Sales', token: 'sales-token' }],
      });
    });

    it('sends a typed secret for the call without saving it', async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        signingSecret: 'project-signing-secret',
      });

      await formCall('buttons', 'sendInvite', { values: { mailbox: support, signingSecret: 'typed-but-unsaved' } });
      const blank = await formCall('buttons', 'sendInvite', { values: { mailbox: support, signingSecret: '' } });

      expect(blank.statusCode).toBe(200);
      expect(service.pod.receivedFormCalls.map((received) => received.values.signingSecret)).toEqual([
        'typed-but-unsaved',
        'project-signing-secret',
      ]);
    });

    it('passes every button result kind through', async () => {
      const results = [
        { message: 'Invite sent', level: 'success' },
        { image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' }, caption: 'Scan it' },
        { link: 'https://invite.example.test/qr', label: 'Open QR code' },
      ];
      for (const result of results) {
        service.pod.scriptFormCall('buttons', 'sendInvite', () => result);
        const res = await formCall('buttons', 'sendInvite', { values: { mailbox: support } });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual(result);
      }
    });

    it('withholds an answer that echoes a secret it was sent', async () => {
      service.pod.scriptFormCall('info', 'accountsSummary', (_request, ctx) => ({
        text: `key ${(ctx.serviceConfiguration.apiKey as { reveal(): string }).reveal()}`,
      }));

      const res = await formCall('info', 'accountsSummary', { values: { mailbox: support } });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'secret-in-response' });
      expect(res.body).not.toContain('crm-key-1');
      expect(await callRow(res.json().callId)).toMatchObject({ kind: 'form', code: 'secret-in-response' });
    });

    it('passes a service problem through with the callId', async () => {
      service.pod.scriptFormCall('options', 'listAccounts', () => {
        throw new ServiceError({ status: 422, code: 'mailbox-required', detail: 'Pick a mailbox first.' });
      });

      const res = await formCall('options', 'listAccounts', { values: {} });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'mailbox-required', detail: 'Pick a mailbox first.' });
      expect(await callRow(res.json().callId)).toMatchObject({
        kind: 'form',
        decision: 'allowed',
        status: 422,
        code: 'mailbox-required',
      });
    });

    it('answers timeout after 10 s and logs the form call', { timeout: 30_000 }, async () => {
      service.pod.slowFormCall('options', 'listAccounts', 20_000);

      const started = Date.now();
      const res = await formCall('options', 'listAccounts', { values: { mailbox: support } });

      expect(res.statusCode).toBe(502);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({ code: 'timeout' });
      expect(Date.now() - started).toBeLessThan(16_000);
      expect(await callRow(res.json().callId)).toMatchObject({
        kind: 'form',
        via: 'form',
        operation: 'listAccounts',
        status: 502,
        code: 'timeout',
      });
    });
  });
});

describe('form calls from the Service configuration tab', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let operator: PersonFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    operator = await platformOperator(app);
  });

  function formCall(
    route: FormCallRoute,
    name: string,
    payload: Record<string, unknown>,
    person: PersonFixture = operator
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/external-services/platform/services/${serviceId}/${route}/${name}`,
      headers: person.headers,
      payload,
    });
  }

  function operatorFormRows() {
    return db
      .select()
      .from(externalServiceCalls)
      .where(and(eq(externalServiceCalls.userId, operator.userId), eq(externalServiceCalls.kind, 'form')));
  }

  it('asks the service about unsaved values before anything is saved', async () => {
    const res = await formCall('info', 'connectionStatus', { values: { region: 'us' } });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ text: 'Region us', level: 'success' });
    expect(await storedPlatformServiceConfiguration(FIXTURE_SERVICE)).toBeNull();
  });

  it('logs a form row with the operator and no Project', async () => {
    await formCall('info', 'connectionStatus', { values: { region: 'eu' } });

    expect(await operatorFormRows()).toEqual([
      expect.objectContaining({
        kind: 'form',
        via: 'form',
        externalServiceId: serviceId,
        operation: 'connectionStatus',
        operationKind: 'info',
        decision: 'allowed',
        status: 200,
        tenantId: null,
        projectId: null,
        projectEnvironmentId: null,
      }),
    ]);
  });

  it("runs a button inside a list item on that item's unsaved values", async () => {
    const res = await formCall('buttons', 'testMailbox', {
      values: {
        mailboxes: [
          { id: 'new_a', label: 'Help desk' },
          { id: 'new_b', label: 'Billing' },
        ],
      },
      item: 'new_b',
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ message: 'Mailbox Billing answered (1 delivered)', level: 'success' });
  });

  it('is only for holders of can_manage_platform_external_services', async () => {
    const admin = await tenantAdmin(app);

    const res = await formCall('info', 'connectionStatus', { values: {} }, admin);

    expect(res.statusCode).toBe(403);
  });

  it('refuses a Project form callback on the Service form route', async () => {
    const res = await formCall('options', 'listAccounts', { values: {} });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown-callback' });
  });

  describe('dispatched to a service pod', () => {
    let service: ServicePodFixture;
    let support: string;

    beforeEach(async () => {
      [support] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string];
      service = await dispatchToFakePod(app, FIXTURE_SERVICE);
    });

    afterEach(async () => {
      await service.stop();
    });

    it('hands the edited item with its stored secrets behind blank boxes, and nothing to the browser', async () => {
      const res = await formCall('buttons', 'testMailbox', {
        values: {
          baseUrl: 'https://crm.example.com/v2',
          region: 'eu',
          apiKey: { stored: true },
          mailboxes: [
            { id: support, label: 'Support desk', token: { stored: true } },
            { id: 'new_c', label: 'Partners', token: 'partners-token' },
          ],
        },
        item: support,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('support-token');
      expect(res.body).not.toContain('crm-key-1');
      const [received] = service.pod.receivedFormCalls;
      expect(received).toMatchObject({
        route: 'buttons',
        name: 'testMailbox',
        form: 'serviceForm',
        values: { id: support, label: 'Support desk', token: 'support-token' },
        serviceConfiguration: {
          baseUrl: 'https://crm.example.com/v2',
          apiKey: 'crm-key-1',
          mailboxes: [{ id: support, label: 'Support desk', token: 'support-token' }],
        },
      });
      expect(received?.caller).toBeUndefined();
    });

    it('never writes the Service configuration', async () => {
      const before = await storedPlatformServiceConfiguration(FIXTURE_SERVICE);

      const res = await formCall('info', 'connectionStatus', { values: { region: 'us', apiKey: 'typed-but-unsaved' } });

      expect(res.statusCode, res.body).toBe(200);
      expect(await storedPlatformServiceConfiguration(FIXTURE_SERVICE)).toEqual(before);
      expect(service.pod.receivedFormCalls[0]?.serviceConfiguration).toMatchObject({ apiKey: 'typed-but-unsaved' });
    });
  });
});

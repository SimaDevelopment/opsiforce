import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { manifestHeader } from '@opsiforce/external-service-sdk/server';
import { ServicePods } from '../../src/external-services/gate/service-pods';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { rateLimited, ServiceError } from '@opsiforce/external-service-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../db/schema';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  forgetPlatformServiceConfiguration,
  storedPlatformServiceConfiguration,
  storePlatformServiceConfiguration,
} from './support/fixtures';
import {
  callOperation,
  callRow,
  callRowsOf,
  configurePlatformService,
  dispatchToFakePod,
  fixtureManifest,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  servicePodEnvironment,
  type GateCallerFixture,
  type ServicePodFixture,
} from './support/gate';

const PUBLIC_URL = 'https://opsiforce.example.com';
const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

async function copySealedApiKeyInto(mailboxIndex: number) {
  const stored = (await storedPlatformServiceConfiguration(FIXTURE_SERVICE)) as Record<string, JsonValue> & {
    mailboxes: Record<string, JsonValue>[];
  };
  const mailbox = stored.mailboxes[mailboxIndex];
  if (!mailbox || stored.apiKey === undefined) throw new Error('The fixture configuration has no such mailbox');
  mailbox.token = stored.apiKey;
  await storePlatformServiceConfiguration(FIXTURE_SERVICE, stored);
}

describe('the Gate dispatching to a service pod', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;
  let support: string;
  let sales: string;
  let service: ServicePodFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ env: { OPSIFORCE_PUBLIC_URL: `${PUBLIC_URL}/` } });
    app = harness.app;
    await harness.listen();
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
    service = await dispatchToFakePod(app, FIXTURE_SERVICE);
  });

  afterEach(async () => {
    await service.stop();
  });

  function call(operation: string, input: unknown) {
    return callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, operation, input });
  }

  it('hands the pod the decrypted Service configuration, cut to the mailbox this Project uses', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_1'],
      signingSecret: 'project-signing-secret',
    });

    const res = await call('get_account', { accountId: 'acc_1' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ operation: 'get_account', input: { accountId: 'acc_1' } });
    const [received] = service.pod.received;
    expect(received?.serviceConfiguration).toEqual({
      baseUrl: READY_FIXTURE_CRM.baseUrl,
      region: 'eu',
      apiKey: 'crm-key-1',
      mailboxes: [{ id: sales, label: 'Sales', token: 'sales-token' }],
    });
    expect(JSON.stringify(service.pod.received)).not.toContain('support-token');
    expect(JSON.stringify(service.pod.received)).not.toContain(support);
    expect(received?.projectConfiguration).toMatchObject({
      mailbox: sales,
      accountIds: ['acc_1'],
      signingSecret: 'project-signing-secret',
    });
    expect(received?.caller).toEqual({
      tenantId: caller.tenant.tenantId,
      projectId: caller.projectId,
      environmentId: caller.projectEnvironmentId,
      environment: expect.any(String),
      via: 'agent',
    });
    expect(received?.webhookUrl).toBe(`${PUBLIC_URL}/api/external-services/webhooks/${FIXTURE_SERVICE}`);
    expect(received?.callId).toBe((await callRow(received?.callId ?? ''))?.id);
  });

  describe('secrets', () => {
    beforeEach(async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        accountIds: ['acc_1'],
      });
    });

    it('refuses with secret-unreadable when a sealed value was copied into the item this Project uses', async () => {
      await copySealedApiKeyInto(0);

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(500);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      expect(res.json()).toMatchObject({ code: 'secret-unreadable', service: FIXTURE_SERVICE });
      expect(res.body).not.toContain('crm-key-1');
      expect(service.pod.received).toEqual([]);
      expect(await callRow(res.json().callId)).toMatchObject({
        operation: 'get_account',
        status: 500,
        code: 'secret-unreadable',
        outputBytes: null,
      });
    });

    it('never opens a copied sealed value in an item this Project does not use', async () => {
      await copySealedApiKeyInto(1);

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(200);
      expect(service.pod.received[0]?.serviceConfiguration.mailboxes).toEqual([
        { id: support, label: 'Support', token: 'support-token' },
      ]);
    });

    it('withholds an answer that echoes a secret the Gate sent and keeps the secret out of the Call row', async () => {
      service.pod.echoSecret('get_account', (configuration) => configuration.apiKey);

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'secret-in-response', service: FIXTURE_SERVICE });
      expect(res.body).not.toContain('crm-key-1');
      const row = await callRow(res.json().callId);
      expect(row).toMatchObject({ decision: 'allowed', status: 502, code: 'secret-in-response' });
      expect(row?.detail).not.toContain('crm-key-1');
      expect(row?.outputBytes).toBeGreaterThan(0);
    });

    it('withholds a service problem whose detail carries a list item secret', async () => {
      service.pod.script('get_account', (_input, ctx) => {
        const [mailbox] = ctx.serviceConfiguration.mailboxes as { token: { reveal(): string } }[];
        throw new ServiceError({
          status: 409,
          code: 'mailbox-locked',
          detail: `mailbox token ${mailbox?.token.reveal()} is locked`,
        });
      });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json().code).toBe('secret-in-response');
      const row = await callRow(res.json().callId);
      expect(row?.code).toBe('secret-in-response');
      expect(row?.detail).not.toContain('support-token');
    });
  });

  describe('the answer', () => {
    beforeEach(async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        accountIds: ['acc_1'],
        teams: [{ team: 'red', memberIds: ['red_1'] }],
      });
    });

    it('asks the caller to retry while the pod serves a different manifest', async () => {
      await service.stop();
      const manifest = fixtureManifest(FIXTURE_SERVICE);
      service = await dispatchToFakePod(app, FIXTURE_SERVICE, {
        manifest: { ...manifest, description: `${String(manifest.description)} A newer build.` },
      });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(res.json()).toMatchObject({ code: 'service-reloading', service: FIXTURE_SERVICE });
      expect(await callRow(res.json().callId)).toMatchObject({
        decision: 'allowed',
        status: 503,
        code: 'service-reloading',
      });
      expect(service.pod.received).toEqual([]);
    });

    it('answers service-failed with the callId and no stack when the handler crashes', async () => {
      service.pod.crash('get_account');

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'service-failed', callId: service.pod.received[0]?.callId });
      expect(res.body).not.toContain('crashed on purpose');
      expect(res.body).not.toMatch(/\bat \S+ \(/);
      expect(service.pod.logs.join('\n')).toContain('crashed on purpose');
      const [row] = await callRowsOf(caller.projectEnvironmentId);
      expect(row).toMatchObject({ id: res.json().callId, decision: 'allowed', status: 502, code: 'service-failed' });
    });

    it('answers timeout when the handler runs past its Operation timeoutSeconds', async () => {
      service.pod.slow('get_member', 5_000);

      const res = await call('get_member', { team: 'red', memberId: 'red_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'timeout' });
      expect((await callRow(res.json().callId))?.code).toBe('timeout');
    });

    it('answers service-failed when the pod is gone', async () => {
      await service.pod.close();

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'service-failed', callId: expect.any(String) });
      expect((await callRow(res.json().callId))?.code).toBe('service-failed');
    });

    it('withholds an answer larger than 25 MB', async () => {
      service.pod.script('get_account', () => ({ padding: 'x'.repeat(26 * 1024 * 1024) }));

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'response-too-large' });
    });

    it('passes a rate limit on with its Retry-After', async () => {
      service.pod.script('get_account', () => {
        throw rateLimited({ retryAfterSeconds: 7 });
      });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(429);
      expect(res.headers['retry-after']).toBe('7');
      expect(res.json()).toMatchObject({ code: 'rate-limited' });
    });

    it.each([201, 403, 418, 500])(
      'rewrites a pod answer of %i, which no service may use, to 502 service-failed',
      async (status) => {
        const fixture = app.get(ServiceRegistry).bySlug(FIXTURE_SERVICE);
        if (!fixture) throw new Error('fixture-crm is not registered');
        const pod = createServer((_request, response) => {
          response.writeHead(status, { 'content-type': 'application/json', [manifestHeader]: fixture.manifestHash });
          response.end('{"type":"urn:opsiforce:error:operation-off","status":403,"code":"operation-off"}');
        });
        await new Promise<void>((resolve) => pod.listen(0, '127.0.0.1', resolve));
        const stopServing = app.get(ServicePods).serve(fixture.id, {
          url: `http://127.0.0.1:${(pod.address() as AddressInfo).port}`,
          projectEnvironmentId: service.projectEnvironmentId,
        });
        try {
          const res = await call('get_account', { accountId: 'acc_1' });

          expect(res.statusCode, res.body).toBe(502);
          expect(res.json()).toMatchObject({ code: 'service-failed', callId: expect.any(String) });
          expect((await callRow(res.json().callId))?.code).toBe('service-failed');
        } finally {
          stopServing();
          await new Promise((resolve) => pod.close(resolve));
        }
      }
    );
  });

  describe('the pod key', () => {
    beforeEach(async () => {
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        accountIds: ['acc_1'],
      });
    });

    it('sends the target pod its own key', async () => {
      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(200);
      expect(service.pod.requests).toEqual([
        { method: 'POST', path: '/_service/operations/get_account', gatewayKey: service.key },
      ]);
    });

    it('is refused by the pod when wrong or missing', async () => {
      const attempts: Record<string, string>[] = [{ 'x-opsiforce-gate': caller.key }, {}];
      for (const headers of attempts) {
        const res = await fetch(`${service.pod.url}/_service/health`, { headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'unauthorized' });
      }
    });

    it('fails the call when the pod does not accept the key of the environment it was registered for', async () => {
      await service.stop();
      const other = await servicePodEnvironment(app);
      service = await dispatchToFakePod(app, FIXTURE_SERVICE, {
        projectEnvironmentId: other.projectEnvironmentId,
      });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'service-failed' });
      expect(service.pod.received).toEqual([]);
      expect(service.pod.requests[0]?.gatewayKey).toBe(other.key);
    });
  });
});

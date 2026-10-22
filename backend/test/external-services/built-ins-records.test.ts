import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { TENANT_SERVICES } from './support/custom-services';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  tenantAdmin,
  type PersonFixture,
} from './support/fixtures';
import { callThroughGate } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import { environmentDatabase } from './support/inbound';
import { EMAIL_SERVICE, MAILGUN_SIGNING_KEY, RECEIVING_DOMAIN, sendMail } from './support/incoming-email';
import { consumerIn, saveConsumerConfiguration } from './support/published-services';

interface CallLogEntry {
  callerKind: string;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: string;
  reason: string | null;
  status: number;
}

interface CallLogPage {
  calls: CallLogEntry[];
  projects: { projectId: string; title: string | null }[];
  retentionDays: number;
}

describe('a built-in’s Calls and Usage, recorded by the built-ins adapter', () => {
  let storageRoot: string;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let admin: PersonFixture;
  let serviceId: string;
  let receiving: GateCallerFixture;
  let unconnected: GateCallerFixture;
  let localPart: string;

  const boot = () =>
    createExternalServicesTestApp({
      builtInsDir: shippedBuiltInServicesDir(),
      env: { STORAGE_MOUNT_PATH: storageRoot },
      config: { mailgunReceiveDomain: RECEIVING_DOMAIN, mailgunWebhookSigningKey: MAILGUN_SIGNING_KEY },
    });

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'built-ins-records-'));
    const before = await boot();
    await forgetPlatformServiceConfiguration(EMAIL_SERVICE);
    await before.close();
    harness = await boot();
    app = harness.app;
    await harness.listen();
    serviceId = await builtInServiceId(EMAIL_SERVICE);
    admin = await tenantAdmin(app);
    receiving = await consumerIn(app, admin.tenant);
    unconnected = await consumerIn(app, admin.tenant);
    localPart = (await saveConsumerConfiguration(app, receiving, EMAIL_SERVICE, {})).values.localPart as string;

    const told = await callThroughGate(
      app,
      { credential: `Bearer ${receiving.key}`, slug: EMAIL_SERVICE },
      '/address?verbose=1'
    );
    expect(told.status).toBe(200);
    await told.text();
    const refused = await callThroughGate(
      app,
      { credential: `Bearer ${unconnected.key}`, slug: EMAIL_SERVICE },
      '/address'
    );
    expect(refused.status).toBe(403);
    await refused.text();
    const mailed = await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}` });
    expect(mailed.status, await mailed.text()).toBe(200);
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  function read(url: string) {
    return app.inject({ method: 'GET', url, headers: admin.headers });
  }

  async function callLog(url: string, expectedRows: number): Promise<CallLogPage> {
    return vi.waitFor(async () => {
      const res = await read(url);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<CallLogPage>();
      expect(page.calls).toHaveLength(expectedRows);
      return page;
    });
  }

  it('shows the Organization’s calls on the service page in a pod’s Call log shape: path without query, outcome and reason', async () => {
    const page = await callLog(`${TENANT_SERVICES}/${serviceId}/call-log`, 2);

    expect(page.retentionDays).toBe(30);
    expect(page.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerKind: 'call',
          projectId: receiving.projectId,
          projectTitle: receiving.projectTitle,
          projectEnvironmentId: receiving.projectEnvironmentId,
          method: 'GET',
          path: '/address',
          route: "This Project environment's receiving address",
          outcome: 'handled',
          status: 200,
        }),
        expect.objectContaining({
          callerKind: 'call',
          projectId: unconnected.projectId,
          path: '/address',
          outcome: 'not allowed',
          reason: expect.stringContaining('not connected'),
          status: 403,
        }),
      ])
    );
    expect(page.projects.map((project) => project.projectId).toSorted()).toEqual(
      [receiving.projectId, unconnected.projectId].toSorted()
    );
  });

  it('narrows the Calls to one outcome', async () => {
    const page = await callLog(`${TENANT_SERVICES}/${serviceId}/call-log?outcome=not%20allowed`, 1);

    expect(page.calls[0]).toMatchObject({ projectId: unconnected.projectId, outcome: 'not allowed' });
  });

  it('shows a Project dialog only its own environment’s calls', async () => {
    const page = await callLog(
      `/api/external-services/projects/${receiving.projectId}/environments/${receiving.projectEnvironmentId}/services/${serviceId}/call-log`,
      1
    );

    expect(page.calls[0]).toMatchObject({ projectEnvironmentId: receiving.projectEnvironmentId, outcome: 'handled' });
  });

  it('counts requests, refusals and stored Events in the Usage tab, per Project and environment', async () => {
    const usage = await vi.waitFor(async () => {
      const res = await read(`${TENANT_SERVICES}/${serviceId}/usage`);
      expect(res.statusCode, res.body).toBe(200);
      const view = res.json();
      expect(view.totals).toEqual({ requests: 2, not_allowed: 1, events: 1 });
      return view;
    });

    expect(usage.counters.map((counter: { name: string }) => counter.name)).toEqual([
      'requests',
      'not_allowed',
      'failed',
      'events',
    ]);
    expect(usage.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: receiving.projectId,
          values: { requests: 1, events: 1 },
          environments: [expect.objectContaining({ projectEnvironmentId: receiving.projectEnvironmentId })],
        }),
        expect.objectContaining({ projectId: unconnected.projectId, values: { requests: 1, not_allowed: 1 } }),
      ])
    );
    expect((await environmentDatabase(storageRoot, receiving.projectEnvironmentId)).events).toHaveLength(1);
  });
});

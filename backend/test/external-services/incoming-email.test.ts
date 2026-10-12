import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  storedPlatformServiceConfiguration,
} from './support/fixtures';
import { askGate, callOperation } from './support/gate';
import {
  configuringProject,
  readProjectService,
  saveProjectService,
  type ConfiguringProject,
} from './support/generating';
import { environmentDatabase, fileOnDisk, latestInboundCall } from './support/inbound';
import {
  EMAIL_SERVICE,
  MAILGUN_SIGNING_KEY,
  RECEIVING_DOMAIN,
  RECEIVING_EMAIL,
  runAddressMigration,
  sendMail,
  storeV1Address,
} from './support/incoming-email';

function bootWith(mailgun: { domain: string; signingKey: string }, env: Record<string, string> = {}) {
  return createExternalServicesTestApp({
    builtInsDir: shippedBuiltInServicesDir(),
    env,
    config: { mailgunReceiveDomain: mailgun.domain, mailgunWebhookSigningKey: mailgun.signingKey },
  });
}

describe('incoming email on a deployment upgraded with the Mailgun settings', () => {
  it('imports the receiving domain and signing key once at boot, so email is Available with no operator step', async () => {
    const before = await bootWith({ domain: '', signingKey: '' });
    await forgetPlatformServiceConfiguration(EMAIL_SERVICE);
    await before.close();

    const upgraded = await bootWith({ domain: RECEIVING_DOMAIN, signingKey: MAILGUN_SIGNING_KEY });
    try {
      const operator = await platformOperator(upgraded.app);
      const view = await upgraded.app.inject({
        method: 'GET',
        url: `/api/external-services/platform/services/${await builtInServiceId(EMAIL_SERVICE)}`,
        headers: operator.headers,
      });

      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({
        slug: EMAIL_SERVICE,
        available: true,
        serviceConfiguration: { values: { receivingDomain: RECEIVING_DOMAIN }, missing: [] },
      });
      const stored = await storedPlatformServiceConfiguration(EMAIL_SERVICE);
      expect(JSON.stringify(stored)).not.toContain(MAILGUN_SIGNING_KEY);
      expect(
        upgraded.app
          .get(SecretSealer)
          .open(stored?.signingKey as never, `${await builtInServiceId(EMAIL_SERVICE)}|platform|signingKey`)
      ).toBe(MAILGUN_SIGNING_KEY);
    } finally {
      await upgraded.close();
    }
  });

  it('never overwrites a Service configuration that is already stored', async () => {
    const first = await bootWith({ domain: RECEIVING_DOMAIN, signingKey: MAILGUN_SIGNING_KEY });
    await first.close();

    const later = await bootWith({ domain: 'other.example.test', signingKey: 'another-key' });
    try {
      expect(await storedPlatformServiceConfiguration(EMAIL_SERVICE)).toMatchObject({
        receivingDomain: RECEIVING_DOMAIN,
      });
    } finally {
      await later.close();
    }
  });

  it('writes nothing without the settings, so email stays Needs setup and its webhook answers 503', async () => {
    const before = await bootWith({ domain: '', signingKey: '' });
    await forgetPlatformServiceConfiguration(EMAIL_SERVICE);
    await before.close();

    const unset = await bootWith({ domain: '', signingKey: '' });
    try {
      expect(await storedPlatformServiceConfiguration(EMAIL_SERVICE)).toBeNull();
      const res = await sendMail(unset.app, { to: `abcdefghijklmnop@${RECEIVING_DOMAIN}` });
      expect(res.statusCode).toBe(503);
      expect(res.json().type).toBe('urn:opsiforce:error:service-not-configured');
    } finally {
      await unset.close();
    }
  });
});

describe('receiving email at a Project environment address', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let serviceId: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'incoming-email-'));
    const configured = await bootWith({ domain: '', signingKey: '' });
    await forgetPlatformServiceConfiguration(EMAIL_SERVICE);
    await configured.close();
    harness = await bootWith(
      { domain: RECEIVING_DOMAIN, signingKey: MAILGUN_SIGNING_KEY },
      { STORAGE_MOUNT_PATH: storageRoot }
    );
    app = harness.app;
    serviceId = await builtInServiceId(EMAIL_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function receivingProject(): Promise<{ project: ConfiguringProject; localPart: string }> {
    const project = await configuringProject(app);
    const saved = await saveProjectService(app, project, serviceId, RECEIVING_EMAIL);
    expect(saved.statusCode, saved.body).toBe(200);
    return { project, localPart: saved.json().projectConfiguration.values.localPart as string };
  }

  it('gives an environment an address only once Receive is on and saved', async () => {
    const project = await configuringProject(app);

    const unsaved = await readProjectService(app, project, serviceId);
    expect(unsaved.json().projectConfiguration.values.localPart).toBeUndefined();
    const quiet = await saveProjectService(app, project, serviceId, {});
    expect(quiet.json().projectConfiguration.values.localPart).toBeUndefined();
    const described = await askGate(app, { key: project.key, path: EMAIL_SERVICE });
    expect(described.json().info).toEqual({ address: '' });

    const receiving = await saveProjectService(app, project, serviceId, RECEIVING_EMAIL);
    const localPart = receiving.json().projectConfiguration.values.localPart as string;
    expect(localPart).toMatch(/^[a-z0-9]{16}$/);
    expect((await askGate(app, { key: project.key, path: EMAIL_SERVICE })).json().info).toEqual({
      address: `${localPart}@${RECEIVING_DOMAIN}`,
    });
  });

  it('gives the configuration dialog the receiving domain its address template needs, and no secret', async () => {
    const project = await configuringProject(app);

    const view = await readProjectService(app, project, serviceId);

    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().templateValues).toEqual({ 'serviceConfiguration.receivingDomain': RECEIVING_DOMAIN });
    expect(view.body).not.toContain(MAILGUN_SIGNING_KEY);
  });

  it('stores mail sent to the address as an email.received Event with its attachments as files', async () => {
    const { project, localPart } = await receivingProject();

    const res = await sendMail(app, {
      to: `${localPart.toUpperCase()}@${RECEIVING_DOMAIN}`,
      subject: 'Order 7',
      text: 'Two boxes, please.',
      attachments: [{ filename: 'order.csv', mimeType: 'text/csv', text: 'sku,qty\nbox,2\n' }],
    });

    expect(res.statusCode, res.body).toBe(200);
    const stored = await environmentDatabase(storageRoot, project.projectEnvironmentId);
    expect(stored.events).toEqual([
      expect.objectContaining({
        service: EMAIL_SERVICE,
        type: 'email.received',
        data: expect.objectContaining({
          address: localPart,
          recipient: `${localPart}@${RECEIVING_DOMAIN}`,
          from: 'ann@customer.example',
          subject: 'Order 7',
          text: 'Two boxes, please.',
          attachments: [{ filename: 'order.csv', mimeType: 'text/csv', size: 14 }],
        }),
      }),
    ]);
    expect(stored.eventFiles).toEqual([expect.objectContaining({ name: 'order.csv', mimeType: 'text/csv' })]);
    expect(await fileOnDisk(storageRoot, project.projectEnvironmentId, stored.eventFiles[0].path)).toBe(
      'sku,qty\nbox,2\n'
    );
  });

  it('refuses mail with a wrong signature and stores nothing', async () => {
    const { project, localPart } = await receivingProject();

    const res = await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}`, signingKey: 'not-the-key' });

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('urn:opsiforce:error:invalid-signature');
    expect((await environmentDatabase(storageRoot, project.projectEnvironmentId)).events).toEqual([]);
  });

  it('answers 200 to mail for an address no environment has, logging it unmatched', async () => {
    const res = await sendMail(app, { to: `nobodyhasthisone@${RECEIVING_DOMAIN}` });

    expect(res.statusCode, res.body).toBe(200);
    expect(await latestInboundCall(EMAIL_SERVICE)).toMatchObject({ code: 'unmatched' });
  });

  it('stops receiving at an address once Receive is switched off', async () => {
    const { project, localPart } = await receivingProject();
    await saveProjectService(app, project, serviceId, { receive: { 'email.received': false } });

    await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}` });

    expect((await environmentDatabase(storageRoot, project.projectEnvironmentId)).events).toEqual([]);
  });

  it('moves an existing address into a Project configuration that receives, keeping it claimed', async () => {
    const project = await configuringProject(app);
    await storeV1Address(project.projectEnvironmentId, `k3p9x2mq7fd41abv@${RECEIVING_DOMAIN}`);

    await runAddressMigration();

    const view = (await readProjectService(app, project, serviceId)).json().projectConfiguration;
    expect(view).toMatchObject({ values: { localPart: 'k3p9x2mq7fd41abv' }, receive: { 'email.received': true } });
    await sendMail(app, { to: `k3p9x2mq7fd41abv@${RECEIVING_DOMAIN}`, subject: 'Still here' });
    expect((await environmentDatabase(storageRoot, project.projectEnvironmentId)).events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ subject: 'Still here' }) }),
    ]);
    const other = await configuringProject(app);
    const taken = await saveProjectService(app, other, serviceId, {
      ...RECEIVING_EMAIL,
      localPart: 'k3p9x2mq7fd41abv',
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().errors).toEqual([{ pointer: '/localPart', message: 'is taken' }]);
  });

  it('keeps the local part of an address on another domain, now on the configured one', async () => {
    const project = await configuringProject(app);
    await storeV1Address(project.projectEnvironmentId, 'Q1W2E3R4T5Y6U7I8@old-mail.example.test');

    await runAddressMigration();

    const described = await askGate(app, { key: project.key, path: EMAIL_SERVICE });
    expect(described.json().info).toEqual({ address: `q1w2e3r4t5y6u7i8@${RECEIVING_DOMAIN}` });
    await sendMail(app, { to: `q1w2e3r4t5y6u7i8@${RECEIVING_DOMAIN}` });
    expect((await environmentDatabase(storageRoot, project.projectEnvironmentId)).events).toHaveLength(1);
  });

  it('leaves an environment that already has its own address as it is', async () => {
    const { project, localPart } = await receivingProject();
    await storeV1Address(project.projectEnvironmentId, `zzzzyyyyxxxxwwww@${RECEIVING_DOMAIN}`);

    await runAddressMigration();

    expect((await readProjectService(app, project, serviceId)).json().projectConfiguration.values.localPart).toBe(
      localPart
    );
  });

  it('serves none of the old address routes', async () => {
    const { project } = await receivingProject();
    const operator = await platformOperator(app);

    const regenerate = await callOperation(app, { key: project.key, slug: EMAIL_SERVICE, operation: 'regenerate' });
    const identity = await askGate(app, { key: project.key, path: `${EMAIL_SERVICE}/identity` });
    const adminAddress = await app.inject({
      method: 'GET',
      url: `/api/external-services/admin/${EMAIL_SERVICE}/environments/${project.projectEnvironmentId}/address`,
      headers: operator.headers,
    });

    expect(regenerate.statusCode).toBe(404);
    expect(regenerate.json().type).toBe('urn:opsiforce:error:unknown-operation');
    expect(identity.statusCode).toBe(404);
    expect(adminAddress.statusCode).toBe(404);
  });
});

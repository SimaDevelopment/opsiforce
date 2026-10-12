import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../db/schema';
import { SecretSealer, SecretUnreadableError } from '../../src/sealing/secret-sealer';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  storedPlatformServiceConfiguration,
  type PersonFixture,
} from './support/fixtures';

const VALID = { baseUrl: 'https://crm.example.com', region: 'eu', apiKey: 'crm-key-1' };

interface MailboxView {
  id: string;
  label: string;
  token: unknown;
}

describe('saving the Service configuration of a Built-in External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let configurationUrl: string;
  let serviceUrl: string;
  let serviceId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
    serviceUrl = `/api/external-services/platform/services/${serviceId}`;
    configurationUrl = `${serviceUrl}/configuration`;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
  });

  function save(values: Record<string, unknown>) {
    return app.inject({ method: 'PUT', url: configurationUrl, headers: operator.headers, payload: { values } });
  }

  function opens(sealed: JsonValue | undefined, path: string): JsonValue {
    return app.get(SecretSealer).open(sealed ?? null, `${serviceId}|platform|${path}`);
  }

  it('makes the service Available and answers with the secret only as "stored"', async () => {
    const res = await save(VALID);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      serviceConfiguration: {
        values: { baseUrl: VALID.baseUrl, region: 'eu', apiKey: { stored: true } },
        missing: [],
      },
    });
    expect(res.body).not.toContain(VALID.apiKey);

    const reread = await app.inject({ method: 'GET', url: serviceUrl, headers: operator.headers });
    expect(reread.json().serviceConfiguration.values.apiKey).toEqual({ stored: true });
    expect(reread.body).not.toContain(VALID.apiKey);
  });

  it('refuses values that do not fit the Service form with a field-level problem, storing nothing', async () => {
    const res = await save({ ...VALID, baseUrl: 'ftp://crm.example.com', region: 'mars' });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-configuration',
      status: 400,
      errors: expect.arrayContaining([
        { pointer: '/baseUrl', message: 'must be an https URL' },
        { pointer: '/region', message: 'must be one of: eu, us' },
      ]),
    });
    expect(await storedPlatformServiceConfiguration(FIXTURE_SERVICE)).toBeNull();
  });

  it('refuses a configuration that leaves a required field empty', async () => {
    const res = await save({ baseUrl: VALID.baseUrl, region: 'eu', apiKey: '' });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([{ pointer: '/apiKey', message: 'is required' }]);
  });

  it('keeps the stored secret when the secret box is left blank', async () => {
    await save(VALID);
    const sealedBefore = (await storedPlatformServiceConfiguration(FIXTURE_SERVICE))?.apiKey;

    for (const blank of ['', null, { stored: true }, undefined]) {
      const res = await save({ ...VALID, region: 'us', apiKey: blank });
      expect(res.statusCode, `${JSON.stringify(blank)}: ${res.body}`).toBe(200);
    }

    const stored = await storedPlatformServiceConfiguration(FIXTURE_SERVICE);
    expect(stored?.region).toBe('us');
    expect(stored?.apiKey).toEqual(sealedBefore);
    expect(opens(stored?.apiKey, 'apiKey')).toBe(VALID.apiKey);
  });

  it('replaces the stored secret when a new one is typed', async () => {
    await save(VALID);

    await save({ ...VALID, apiKey: 'crm-key-2' });

    expect(opens((await storedPlatformServiceConfiguration(FIXTURE_SERVICE))?.apiKey, 'apiKey')).toBe('crm-key-2');
  });

  it('seals each secret on its own, bound to its field path, so a copied blob does not open elsewhere', async () => {
    const res = await save({
      ...VALID,
      mailboxes: [
        { label: 'Sales', token: 'sales-token' },
        { label: 'Support', token: 'support-token' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const [sales, support] = res.json().serviceConfiguration.values.mailboxes as MailboxView[];
    expect(sales?.token).toEqual({ stored: true });

    const stored = await storedPlatformServiceConfiguration(FIXTURE_SERVICE);
    const storedMailboxes = stored?.mailboxes as Array<Record<string, JsonValue>>;
    expect(JSON.stringify(stored)).not.toContain('sales-token');
    expect(opens(stored?.apiKey, 'apiKey')).toBe(VALID.apiKey);
    expect(opens(storedMailboxes[0]?.token, `mailboxes.${sales?.id}.token`)).toBe('sales-token');
    expect(opens(storedMailboxes[1]?.token, `mailboxes.${support?.id}.token`)).toBe('support-token');

    expect(() => opens(storedMailboxes[1]?.token, `mailboxes.${sales?.id}.token`)).toThrow(SecretUnreadableError);
    expect(() => opens(storedMailboxes[0]?.token, 'apiKey')).toThrow(SecretUnreadableError);
  });

  it('gives each new list item an id it keeps, and keeps an item secret left blank', async () => {
    const first = await save({ ...VALID, mailboxes: [{ label: 'Sales', token: 'sales-token' }] });
    const [sales] = first.json().serviceConfiguration.values.mailboxes as MailboxView[];
    expect(sales?.id).toMatch(/^li_[0-9a-f]{16}$/);

    const second = await save({
      ...VALID,
      mailboxes: [
        { id: sales?.id, label: 'Sales EMEA', token: '' },
        { label: 'Support', token: 'support-token' },
      ],
    });

    expect(second.statusCode, second.body).toBe(200);
    const mailboxes = second.json().serviceConfiguration.values.mailboxes as MailboxView[];
    expect(mailboxes).toEqual([
      { id: sales?.id, label: 'Sales EMEA', token: { stored: true } },
      { id: expect.stringMatching(/^li_/), label: 'Support', token: { stored: true } },
    ]);
    const storedMailboxes = (await storedPlatformServiceConfiguration(FIXTURE_SERVICE))?.mailboxes as Array<
      Record<string, JsonValue>
    >;
    expect(opens(storedMailboxes[0]?.token, `mailboxes.${sales?.id}.token`)).toBe('sales-token');
  });

  it('refuses a new list item whose secret is blank, since there is nothing stored to keep', async () => {
    const res = await save({ ...VALID, mailboxes: [{ id: 'li_made_up', label: 'Sales', token: '' }] });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([{ pointer: '/mailboxes/0/token', message: 'is required' }]);
  });
});

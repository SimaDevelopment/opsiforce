import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../db/schema';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { evolvedHooks, fixtureCrmEvolved, type EvolvedBuiltIns } from './support/evolved-built-ins';
import { retryServiceConfigurationHook, saveServiceConfiguration } from './support/generating';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  storedPlatformServiceConfiguration,
  storePlatformServiceConfiguration,
  type PersonFixture,
} from './support/fixtures';

describe('reading a Service configuration stored under an older Service form', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;
  let serviceUrl: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
    serviceUrl = `/api/external-services/platform/services/${serviceId}`;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
  });

  function sealedApiKey(value: string): JsonValue {
    return app.get(SecretSealer).seal(value, `${serviceId}|platform|apiKey`);
  }

  async function view() {
    const res = await app.inject({ method: 'GET', url: serviceUrl, headers: operator.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('moves a value stored under the key a field "was"', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      apiUrl: 'https://old.crm.example.com',
      region: 'eu',
      apiKey: sealedApiKey('crm-key-1'),
    });

    expect(await view()).toMatchObject({
      available: true,
      serviceConfiguration: { values: { baseUrl: 'https://old.crm.example.com' }, missing: [] },
    });
  });

  it('stores a moved value under its new key on the next save', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      apiUrl: 'https://old.crm.example.com',
      region: 'eu',
      apiKey: sealedApiKey('crm-key-1'),
    });
    const { serviceConfiguration } = await view();

    const res = await app.inject({
      method: 'PUT',
      url: `${serviceUrl}/configuration`,
      headers: operator.headers,
      payload: { values: serviceConfiguration.values },
    });

    expect(res.statusCode, res.body).toBe(200);
    const stored = await storedPlatformServiceConfiguration(FIXTURE_SERVICE);
    expect(stored).toMatchObject({ baseUrl: 'https://old.crm.example.com' });
    expect(stored).not.toHaveProperty('apiUrl');
  });

  it('counts a value that no longer fits its field as missing, and keeps it stored', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      baseUrl: 'https://crm.example.com',
      region: 'asia',
      apiKey: sealedApiKey('crm-key-1'),
    });

    const body = await view();

    expect(body.available).toBe(false);
    expect(body.serviceConfiguration.missing).toEqual(['region']);
    expect(body.serviceConfiguration.values).not.toHaveProperty('region');
    expect((await storedPlatformServiceConfiguration(FIXTURE_SERVICE))?.region).toBe('asia');
  });

  it('drops a misfit optional value without making the service need setup', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      baseUrl: 'https://crm.example.com',
      region: 'eu',
      apiKey: sealedApiKey('crm-key-1'),
      timeoutSeconds: 'soon',
    });

    const body = await view();

    expect(body.available).toBe(true);
    expect(body.serviceConfiguration.values).not.toHaveProperty('timeoutSeconds');
  });

  it('counts a secret that is not a sealed value as missing', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      baseUrl: 'https://crm.example.com',
      region: 'eu',
      apiKey: 'plaintext-key',
    });

    const body = await view();

    expect(body.serviceConfiguration.missing).toEqual(['apiKey']);
    expect(JSON.stringify(body)).not.toContain('plaintext-key');
  });

  it('never returns keys the Service form no longer has, and keeps them in storage across a save', async () => {
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      baseUrl: 'https://crm.example.com',
      region: 'eu',
      apiKey: sealedApiKey('crm-key-1'),
      legacyMode: 'classic',
    });

    const { serviceConfiguration } = await view();
    expect(serviceConfiguration.values).not.toHaveProperty('legacyMode');

    const res = await app.inject({
      method: 'PUT',
      url: `${serviceUrl}/configuration`,
      headers: operator.headers,
      payload: { values: { ...serviceConfiguration.values, region: 'us', legacyMode: 'modern' } },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().serviceConfiguration.values).not.toHaveProperty('legacyMode');
    expect(await storedPlatformServiceConfiguration(FIXTURE_SERVICE)).toMatchObject({
      region: 'us',
      legacyMode: 'classic',
    });
  });
});

describe('a failed after-save hook once a secret field was renamed', () => {
  let evolved: EvolvedBuiltIns;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;

  beforeAll(async () => {
    evolved = await fixtureCrmEvolved((manifest) => {
      const fields = manifest.serviceForm as Record<string, unknown>[];
      const apiKey = fields.find((field) => field.key === 'apiKey');
      if (!apiKey) throw new Error('fixture-crm has no apiKey field');
      apiKey.key = 'apiSecret';
      apiKey.was = 'apiKey';
    });
    harness = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
    await evolved.remove();
  });

  it('still opens the secret stored under its old key when Retry resends the first previous', async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, {
      baseUrl: 'https://crm.example.com',
      region: 'eu',
      apiKey: app.get(SecretSealer).seal('crm-key-1', `${serviceId}|platform|apiKey`),
    });
    const hooks = evolvedHooks();
    hooks.fail = true;
    try {
      const saved = await saveServiceConfiguration(app, operator, serviceId, {
        baseUrl: 'https://crm.example.com',
        region: 'us',
        apiSecret: { stored: true },
      });
      expect(saved.json().hookFailure).toMatchObject({ code: 'service-failed' });

      hooks.fail = false;
      const retried = await retryServiceConfigurationHook(app, operator, serviceId);

      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().hookFailure).toBeNull();
      expect(hooks.seen.at(-1)).toMatchObject({
        previous: { region: 'eu', apiSecret: 'crm-key-1' },
        current: { region: 'us', apiSecret: 'crm-key-1' },
      });
    } finally {
      hooks.fail = false;
    }
  });
});

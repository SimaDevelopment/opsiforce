import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  tenantAdmin,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';

const PLATFORM_SERVICES = '/api/external-services/platform/services';
const TENANT_SERVICES = '/api/external-services/services';
const FIXTURE_SKILL_LINE = 'Accounts belong to pipelines.';

describe('what a Built-in External Service page shows', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let admin: PersonFixture;
  let fixtureId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ env: { OPSIFORCE_PUBLIC_URL: 'https://opsiforce.example.com/' } });
    app = harness.app;
    operator = await platformOperator(app);
    admin = await tenantAdmin(app);
    fixtureId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
  });

  it('gives the operator the Service skill the agent reads and the webhook URL built from the public URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PLATFORM_SERVICES}/${fixtureId}`,
      headers: operator.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.serviceSkill).toContain('name: service-fixture-crm');
    expect(body.serviceSkill).toContain(FIXTURE_SKILL_LINE);
    expect(body.webhookUrl).toBe('https://opsiforce.example.com/api/external-services/webhooks/fixture-crm');
  });

  it('keeps the Service skill and webhook URL in the view a save answers with', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${PLATFORM_SERVICES}/${fixtureId}/configuration`,
      headers: operator.headers,
      payload: { values: { baseUrl: 'https://crm.example.com', region: 'eu', apiKey: 'crm-key-1' } },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      serviceSkill: expect.stringContaining(FIXTURE_SKILL_LINE),
      webhookUrl: 'https://opsiforce.example.com/api/external-services/webhooks/fixture-crm',
    });
  });

  it('shows an Organization admin the Service skill of an Available built-in, but no webhook URL', async () => {
    await app.inject({
      method: 'PUT',
      url: `${PLATFORM_SERVICES}/${fixtureId}/configuration`,
      headers: operator.headers,
      payload: { values: { baseUrl: 'https://crm.example.com', region: 'eu', apiKey: 'crm-key-1' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${fixtureId}`,
      headers: admin.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.serviceSkill).toContain(FIXTURE_SKILL_LINE);
    expect(body).not.toHaveProperty('webhookUrl');
  });
});

describe('a deployment without a valid public URL', () => {
  it.each([
    ['an empty', ''],
    ['a relative', '/opsiforce'],
    ['a non-http', 'ftp://opsiforce.example.com'],
  ])('refuses to boot with %s OPSIFORCE_PUBLIC_URL', async (_case, publicUrl) => {
    await expect(createExternalServicesTestApp({ env: { OPSIFORCE_PUBLIC_URL: publicUrl } })).rejects.toThrow(
      /OPSIFORCE_PUBLIC_URL/
    );
  });
});

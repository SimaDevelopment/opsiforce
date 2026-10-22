import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  memberWithout,
  tenantAdmin,
  platformOperator,
  storedPlatformServiceConfiguration,
  storePlatformServiceConfiguration,
  type PersonFixture,
} from './support/fixtures';

const TENANT_SERVICES = '/api/external-services/services';

describe('which Built-in External Services an Organization is offered', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let admin: PersonFixture;
  let fixtureId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
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

  async function configureFixture() {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/external-services/platform/services/${fixtureId}/configuration`,
      headers: operator.headers,
      payload: { values: { baseUrl: 'https://crm.example.com', region: 'eu', apiKey: 'crm-key-1' } },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function offeredSlugs(): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: TENANT_SERVICES, headers: admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Array<{ slug: string }>>().map((service) => service.slug);
  }

  it('hides a built-in that needs setup from the Organization', async () => {
    expect(await offeredSlugs()).not.toContain(FIXTURE_SERVICE);
    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${fixtureId}`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('offers it once its Service configuration validates, without the Service form or any value', async () => {
    await configureFixture();

    expect(await offeredSlugs()).toContain(FIXTURE_SERVICE);
    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${fixtureId}`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: fixtureId,
      slug: FIXTURE_SERVICE,
      origin: 'built_in',
      displayName: 'Fixture CRM',
    });
    expect(body.manifest.projectForm.map((field: { key?: string }) => field.key)).toContain('mailbox');
    expect(body.manifest).not.toHaveProperty('serviceForm');
    expect(body).not.toHaveProperty('serviceConfiguration');
    expect(res.body).not.toContain('crm.example.com');
  });

  it('hides it again when a stored value stops fitting the Service form', async () => {
    await configureFixture();
    const stored = await storedPlatformServiceConfiguration(FIXTURE_SERVICE);
    await storePlatformServiceConfiguration(FIXTURE_SERVICE, { ...stored, region: 'asia' });

    expect(await offeredSlugs()).not.toContain(FIXTURE_SERVICE);
  });

  it('refuses a member who holds neither External Services permission', async () => {
    const member = await memberWithout(app);
    for (const url of [TENANT_SERVICES, `${TENANT_SERVICES}/${fixtureId}`]) {
      const res = await app.inject({ method: 'GET', url, headers: member.headers });
      expect(res.statusCode, url).toBe(403);
    }
  });
});

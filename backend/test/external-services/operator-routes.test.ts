import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProject, serviceKeyFor } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  memberWithout,
  tenantAdmin,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';

const PLATFORM_SERVICES = '/api/external-services/platform/services';

describe('the platform operator routes for Built-in External Services', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let fixtureId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    operator = await platformOperator(app);
    fixtureId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
  });

  it('lists the built-ins, marking one without its required Service configuration as not Available', async () => {
    const res = await app.inject({ method: 'GET', url: PLATFORM_SERVICES, headers: operator.headers });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: fixtureId,
        slug: FIXTURE_SERVICE,
        origin: 'built_in',
        displayName: 'Fixture CRM',
        description: 'A pretend CRM that the backend tests configure and call.',
        available: false,
      }),
    ]);
  });

  it('opens one built-in with its manifest and names the required fields still missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PLATFORM_SERVICES}/${fixtureId}`,
      headers: operator.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: fixtureId,
      slug: FIXTURE_SERVICE,
      available: false,
      icon: expect.stringContaining('<svg'),
      serviceConfiguration: { values: {}, missing: ['baseUrl', 'region', 'apiKey'] },
    });
    expect(body.manifest).not.toHaveProperty('operations');
    expect(body.manifest.serviceForm.map((field: { key?: string }) => field.key)).toContain('apiKey');
  });

  it('answers 404 for a service it does not know', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PLATFORM_SERVICES}/00000000-0000-0000-0000-000000000000`,
      headers: operator.headers,
    });

    expect(res.statusCode).toBe(404);
  });

  describe('who may use them', () => {
    const routes = (id: string) => [
      { method: 'GET' as const, url: PLATFORM_SERVICES },
      { method: 'GET' as const, url: `${PLATFORM_SERVICES}/${id}` },
      { method: 'PUT' as const, url: `${PLATFORM_SERVICES}/${id}/configuration`, payload: { values: {} } },
    ];

    it('refuses a member without can_manage_platform_external_services', async () => {
      const member = await memberWithout(app);
      for (const route of routes(fixtureId)) {
        const res = await app.inject({ ...route, headers: member.headers });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    });

    it('refuses an Organization admin, whose permission covers only Organization services', async () => {
      const admin = await tenantAdmin(app);
      for (const route of routes(fixtureId)) {
        const res = await app.inject({ ...route, headers: admin.headers });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    });

    it("refuses a pod calling with its environment's gw- key", async () => {
      const projectId = await createProject(app, operator.tenant);
      const key = await serviceKeyFor(app, operator.tenant, projectId);
      for (const route of routes(fixtureId)) {
        const res = await app.inject({ ...route, headers: { authorization: `Bearer ${key}` } });
        expect([401, 403], `${route.method} ${route.url} answered ${res.statusCode}`).toContain(res.statusCode);
      }
    });
  });
});

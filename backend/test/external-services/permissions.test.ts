import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';

describe('who may administer the platform External Services', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function listServicesAs(permissions: string[]) {
    const tenant = await createTenant(app);
    const member = await addMember(app, tenant, permissions);
    return app.inject({ method: 'GET', url: '/api/external-services/platform/services', headers: member.headers });
  }

  it('lets a platform operator holding can_manage_platform_external_services list the platform services', async () => {
    const res = await listServicesAs(['can_manage_platform_external_services']);

    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('refuses the retired can_manage_external_services name', async () => {
    const res = await listServicesAs(['can_manage_external_services']);

    expect(res.statusCode).toBe(403);
  });

  it('refuses the Organization-scope External Services permissions on the platform services', async () => {
    const res = await listServicesAs([
      'can_manage_tenant_external_services',
      'can_configure_project_external_services',
      'can_manage_project_skills',
    ]);

    expect(res.statusCode).toBe(403);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sdkPackageVersion } from '@opsiforce/external-service-sdk/server';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import { Perms } from '../../src/permission/permission.constants';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  tenantAdmin,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';
import { resolveCaller } from './support/gate-proxy';
import { configurePlatformService, READY_FIXTURE_CRM, type GateCallerFixture } from './support/gate';
import {
  consumerIn,
  publishCustomService,
  READY_BOARDS,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';

const PUBLIC_URL = 'https://opsiforce.example.com';

interface ListedService {
  id: string;
  slug: string;
  origin: string;
  displayName: string;
  hidesBuiltIn?: boolean;
  published?: boolean;
}

describe("an Organization's Custom External Services next to the built-ins", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let admin: PersonFixture;
  let service: PublishedService;
  let consumer: GateCallerFixture;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-resolution-'));
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM);
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
    consumer = await consumerIn(app, admin.tenant);
  });

  function listAs(person: PersonFixture) {
    return app.inject({ method: 'GET', url: TENANT_SERVICES, headers: person.headers });
  }

  function viewAs(person: PersonFixture, id: string) {
    return app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${id}`, headers: person.headers });
  }

  describe('a later built-in with the same name', () => {
    beforeEach(async () => {
      await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
      await db.update(externalServices).set({ slug: FIXTURE_SERVICE }).where(eq(externalServices.id, service.id));
    });

    afterEach(async () => {
      await db.update(externalServices).set({ slug: service.slug }).where(eq(externalServices.id, service.id));
    });

    it("leaves the Organization's agents reaching its own service", async () => {
      const own = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: FIXTURE_SERVICE });
      const elsewhere = await resolveCaller(app, {
        credential: `Bearer ${(await consumerIn(app, (await tenantAdmin(app)).tenant)).key}`,
        slug: FIXTURE_SERVICE,
      });

      expect(own.statusCode, own.body).toBe(200);
      expect(own.json()).toMatchObject({ servedBy: 'pod', serviceId: service.id });
      expect(elsewhere.statusCode, elsewhere.body).toBe(200);
      expect(elsewhere.json()).toMatchObject({
        servedBy: 'built-in',
        serviceId: await builtInServiceId(FIXTURE_SERVICE),
      });
    });

    it('hides the built-in in that Organization and flags its own service with a notice', async () => {
      const res = await listAs(admin);

      expect(res.statusCode, res.body).toBe(200);
      const listed = res.json<ListedService[]>().filter((entry) => entry.slug === FIXTURE_SERVICE);
      expect(listed).toEqual([
        expect.objectContaining({ id: service.id, origin: 'custom', hidesBuiltIn: true, published: true }),
      ]);
      expect((await viewAs(admin, await builtInServiceId(FIXTURE_SERVICE))).statusCode).toBe(404);
      expect((await viewAs(admin, service.id)).json()).toMatchObject({ hidesBuiltIn: true });
    });

    it('still shows the built-in to every other Organization', async () => {
      const other = await tenantAdmin(app);

      const res = await listAs(other);

      expect(res.json<ListedService[]>().filter((entry) => entry.slug === FIXTURE_SERVICE)).toEqual([
        expect.objectContaining({ origin: 'built_in', displayName: 'Fixture CRM' }),
      ]);
    });
  });

  describe('its Service configuration', () => {
    it('shows the Organization admin the Service form, what is missing and its webhook URL', async () => {
      const res = await viewAs(admin, service.id);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        id: service.id,
        slug: 'boards',
        origin: 'custom',
        displayName: 'Fixture Boards',
        available: false,
        builderChatId: service.builderChatId,
        published: true,
        disabled: false,
        sdkVersion: sdkPackageVersion,
        hidesBuiltIn: false,
        webhookUrl: `${PUBLIC_URL}/api/external-services/webhooks/${service.id}`,
        serviceConfiguration: { values: {}, missing: ['apiToken'] },
        manifest: { serviceForm: [{ key: 'apiToken' }, { key: 'apiSecret' }] },
      });
    });

    it('saves it sealed for the Organization and makes the service Available', async () => {
      const res = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        available: true,
        serviceConfiguration: { values: { apiToken: { stored: true }, apiSecret: { stored: true } }, missing: [] },
      });
      expect(res.body).not.toContain('boards-token-1');
    });

    it('refuses invalid values with the configuration problem', async () => {
      const res = await saveCustomServiceConfiguration(app, admin, service.id, { apiToken: 42 });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-configuration' });
    });

    it('is edited only by holders of can_manage_tenant_external_services in its own Organization', async () => {
      const operator = await platformOperator(app);
      const stranger = await tenantAdmin(app);

      expect((await saveCustomServiceConfiguration(app, operator, service.id, READY_BOARDS)).statusCode).toBe(403);
      expect((await saveCustomServiceConfiguration(app, stranger, service.id, READY_BOARDS)).statusCode).toBe(404);
      expect((await viewAs(stranger, service.id)).statusCode).toBe(404);
    });

    it('shows a draft as a Draft with no Service configuration of its own yet', async () => {
      const draft = await createCustomService(app, admin, 'Drafts', 'drafts');

      const page = await viewAs(admin, draft.id);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json()).toMatchObject({ id: draft.id, published: false, defaultEnvironment: null });
      expect(page.json()).not.toHaveProperty('serviceConfiguration');
      expect((await saveCustomServiceConfiguration(app, admin, draft.id, READY_BOARDS)).statusCode).toBe(404);
    });
  });

  describe('the chat bar of a consumer Project', () => {
    function servicesUrl(): string {
      return `/api/external-services/projects/${consumer.projectId}/environments/${consumer.projectEnvironmentId}/services`;
    }

    it('offers the service once it is Available, whether or not the Agent carries its Service skill', async () => {
      const configurer = await addMember(app, admin.tenant, [Perms.configureProjectExternalServices]);
      const before = await app.inject({ method: 'GET', url: servicesUrl(), headers: configurer.headers });
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().services.map((entry: ListedService) => entry.slug)).not.toContain('boards');

      await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
      const after = await app.inject({ method: 'GET', url: servicesUrl(), headers: configurer.headers });
      const saved = await app.inject({
        method: 'PUT',
        url: `${servicesUrl()}/${service.id}/configuration`,
        headers: configurer.headers,
        payload: { values: { boardIds: ['b2'] } },
      });

      expect(after.json().services).toContainEqual(
        expect.objectContaining({ id: service.id, slug: 'boards', origin: 'custom', state: 'available' })
      );
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({
        id: service.id,
        projectConfiguration: { values: { boardIds: ['b2'] } },
      });
    });
  });
});

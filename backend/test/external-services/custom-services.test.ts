import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  builderProjectRow,
  createCustomService,
  customServiceRow,
  customServiceRowsOf,
  ensureExternalServiceBuilder,
  markPublished,
  TENANT_SERVICES,
  postCustomService,
  renameSlug,
} from './support/custom-services';
import { memberWithout, tenantAdmin, platformOperator, type PersonFixture } from './support/fixtures';

describe('creating a Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let builderAgentId: string;
  let admin: PersonFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    builderAgentId = await ensureExternalServiceBuilder();
    admin = await tenantAdmin(app);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('registers the service for the Organization and opens its External Service Builder chat', async () => {
    const res = await postCustomService(app, admin, { name: 'Trello', slug: 'trello' });

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ slug: 'trello', origin: 'custom', displayName: 'Trello', published: false });

    expect(await customServiceRow(created.id)).toMatchObject({
      tenantId: admin.tenant.tenantId,
      origin: 'custom',
      slug: 'trello',
      builderChatId: created.builderChatId,
      defaultEnvironmentId: null,
      createdBy: admin.userId,
    });
    expect(await builderProjectRow(created.builderChatId)).toMatchObject({
      tenantId: admin.tenant.tenantId,
      kind: 'external_service_builder_chat',
      agentId: builderAgentId,
      workspaceId: null,
      title: 'Trello',
      createdBy: admin.userId,
    });
  });

  it.each([
    ['starts with a digit', '1trello'],
    ['is one character', 't'],
    ['has a capital letter', 'Trello'],
    ['has an underscore', 'trello_cards'],
    ['is longer than 31 characters', `t${'r'.repeat(31)}`],
    ['is empty', ''],
    ['is not text', 42],
  ])('refuses a slug that %s', async (_case, slug) => {
    const person = await tenantAdmin(app);

    const res = await postCustomService(app, person, { name: 'Trello', slug });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-slug', status: 400 });
    expect(await customServiceRowsOf(person.tenant.tenantId)).toEqual([]);
  });

  it.each(['usage', 'webhooks', 'agent', 'admin', 'services'])('refuses the reserved word %s', async (slug) => {
    const person = await tenantAdmin(app);

    const res = await postCustomService(app, person, { name: 'Reserved', slug });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-slug',
      detail: `\`${slug}\` is reserved by the platform`,
    });
    expect(await customServiceRowsOf(person.tenant.tenantId)).toEqual([]);
  });

  it("refuses a Built-in External Service's name", async () => {
    const person = await tenantAdmin(app);

    const res = await postCustomService(app, person, { name: 'My CRM', slug: FIXTURE_SERVICE });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:slug-taken' });
    expect(await customServiceRowsOf(person.tenant.tenantId)).toEqual([]);
  });

  it('refuses a slug the Organization already uses and leaves no second builder chat behind', async () => {
    const person = await tenantAdmin(app);
    await createCustomService(app, person, 'Trello', 'trello');

    const res = await postCustomService(app, person, { name: 'Trello again', slug: 'trello' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:slug-taken' });
    expect(await customServiceRowsOf(person.tenant.tenantId)).toHaveLength(1);
  });

  it('lets two Organizations use the same slug', async () => {
    const first = await tenantAdmin(app);
    const second = await tenantAdmin(app);
    await createCustomService(app, first, 'GitHub', 'github');

    const res = await postCustomService(app, second, { name: 'GitHub', slug: 'github' });

    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['blank', '   '],
    ['missing', undefined],
    ['longer than 80 characters', 'n'.repeat(81)],
  ])('refuses a name that is %s', async (_case, name) => {
    const person = await tenantAdmin(app);

    const res = await postCustomService(app, person, { name, slug: 'crm' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:invalid-name' });
  });

  it('is only for holders of can_manage_tenant_external_services', async () => {
    for (const person of [await memberWithout(app), await platformOperator(app)]) {
      const res = await postCustomService(app, person, { name: 'Trello', slug: 'trello' });

      expect(res.statusCode).toBe(403);
      expect(await customServiceRowsOf(person.tenant.tenantId)).toEqual([]);
    }
  });
});

describe('changing a Custom External Service slug', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    await ensureExternalServiceBuilder();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('changes until the first Publish', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Trello', 'trello');

    const res = await renameSlug(app, admin, service.id, 'trello-cards');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: service.id, slug: 'trello-cards' });
    expect(await customServiceRow(service.id)).toMatchObject({ slug: 'trello-cards' });
  });

  it('is locked once the service has a Default environment', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Trello', 'trello');
    await markPublished(service.id, admin.tenant.tenantId);

    const res = await renameSlug(app, admin, service.id, 'trello-cards');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:slug-locked' });
    expect(await customServiceRow(service.id)).toMatchObject({ slug: 'trello' });
  });

  it('follows the same rules as creation', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Trello', 'trello');
    await createCustomService(app, admin, 'GitHub', 'github');

    expect((await renameSlug(app, admin, service.id, 'admin')).statusCode).toBe(400);
    expect((await renameSlug(app, admin, service.id, FIXTURE_SERVICE)).statusCode).toBe(409);
    expect((await renameSlug(app, admin, service.id, 'github')).statusCode).toBe(409);
    expect(await customServiceRow(service.id)).toMatchObject({ slug: 'trello' });
  });

  it("cannot reach another Organization's service", async () => {
    const owner = await tenantAdmin(app);
    const stranger = await tenantAdmin(app);
    const service = await createCustomService(app, owner, 'Trello', 'trello');

    expect((await renameSlug(app, stranger, service.id, 'mine')).statusCode).toBe(404);
  });
});

describe("listing an Organization's Custom External Services", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    await ensureExternalServiceBuilder();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('shows each draft with the builder chat to continue in, to the Organization only', async () => {
    const admin = await tenantAdmin(app);
    const stranger = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Trello', 'trello');

    const own = await app.inject({ method: 'GET', url: TENANT_SERVICES, headers: admin.headers });
    const other = await app.inject({ method: 'GET', url: TENANT_SERVICES, headers: stranger.headers });

    expect(own.json()).toContainEqual({
      id: service.id,
      slug: 'trello',
      origin: 'custom',
      displayName: 'Trello',
      description: '',
      icon: null,
      builderChatId: service.builderChatId,
      published: false,
      disabled: false,
      hidesBuiltIn: false,
    });
    expect(other.json().map((entry: { id: string }) => entry.id)).not.toContain(service.id);
  });
});

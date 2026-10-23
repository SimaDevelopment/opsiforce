import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuilderModule } from '../../src/builder/builder.module';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { addMember, addNamedEnvironment, type MemberFixture } from '../support/project-fixtures';
import { proxyHeaders } from '../support/proxy-identity';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  createCustomService,
  ensureExternalServiceBuilder,
  type CreatedCustomService,
} from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';

const CONTROL_TOKEN = 'proxy-control-token-for-builder-chat-access';

@Module({ controllers: [ProxyController] })
class ProxyTestModule {}

describe('who may open and chat in an External Service Builder chat', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let admin: PersonFixture;
  let service: CreatedCustomService;
  let colleague: MemberFixture;
  let memberWithout: MemberFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({
      env: { PROXY_CONTROL_TOKEN: CONTROL_TOKEN },
      extraModules: [BuilderModule, ProxyTestModule],
    });
    app = harness.app;
    await ensureExternalServiceBuilder();
    admin = await tenantAdmin(app);
    service = await createCustomService(app, admin, 'Trello', 'trello');
    colleague = await addMember(app, admin.tenant, ['can_manage_tenant_external_services']);
    memberWithout = await addMember(app, admin.tenant, ['can_manage_skills', 'can_manage_agents']);
  });

  afterAll(async () => {
    await harness.close();
  });

  function openChat(headers: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/api/builder/chats',
      headers,
      payload: { externalServiceId: service.id },
    });
  }

  function chatIn(environmentId: string, headers: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/api/internal/proxy/projects/${environmentId}/ensure`,
      headers: { 'x-proxy-control-token': CONTROL_TOKEN, ...headers },
      payload: { surface: 'agent' },
    });
  }

  it("lets any holder of can_manage_tenant_external_services continue any of the Organization's builder chats", async () => {
    const opened = await openChat(colleague.headers);

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      id: service.builderChatId,
      kind: 'external_service_builder_chat',
      subject: { type: 'external_service', id: service.id, name: 'trello', displayName: 'Trello', disabled: false },
    });
    expect((await chatIn(service.builderChatId, colleague.headers)).statusCode).toBe(201);
  });

  it('refuses a member without the permission, even one who may build Skills and Agents', async () => {
    expect((await openChat(memberWithout.headers)).statusCode).toBe(403);
    expect((await chatIn(service.builderChatId, memberWithout.headers)).statusCode).toBe(403);
  });

  it('refuses the creator once the permission is gone', async () => {
    const withoutPermission = proxyHeaders({
      userId: admin.keycloakId,
      tenants: [admin.tenant.name],
      permissions: ['can_use_public_api'],
    });

    expect((await openChat(withoutPermission)).statusCode).toBe(403);
    expect((await chatIn(service.builderChatId, withoutPermission)).statusCode).toBe(403);
  });

  it('applies the same rule in every environment of the builder Project', async () => {
    const staging = await addNamedEnvironment(app, admin.tenant, service.builderChatId, 'Staging');

    expect((await chatIn(staging, memberWithout.headers)).statusCode).toBe(403);
    expect((await chatIn(staging, colleague.headers)).statusCode).not.toBe(403);
  });

  it("does not open another Organization's service", async () => {
    const stranger = await tenantAdmin(app);

    expect((await openChat(stranger.headers)).statusCode).toBe(404);
    expect((await chatIn(service.builderChatId, stranger.headers)).statusCode).toBe(404);
  });
});

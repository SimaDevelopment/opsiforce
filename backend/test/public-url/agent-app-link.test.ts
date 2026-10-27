import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectController } from '../../src/project/project.controller';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import { createCustomService, ensureExternalServiceBuilder } from '../support/custom-services';
import { tenantAdmin } from '../support/external-service-fixtures';
import { addMember, createProject, createTenant, type TenantFixture } from '../support/project-fixtures';

const APPS = 'apps.agent-link.test';

@Module({ controllers: [ProjectController] })
class EditUrlRoute {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;

beforeAll(async () => {
  await ensureExternalServiceBuilder();
  harness = await createExternalServicesTestApp({ env: { APPS_HOSTNAME: APPS }, extraModules: [EditUrlRoute] });
  app = harness.app;
});

afterAll(async () => {
  await harness.close();
});

interface AgentFixture {
  tenant: TenantFixture;
  projectId: string;
  key: string;
}

async function agentOf(tenant: TenantFixture, projectId: string): Promise<AgentFixture> {
  const key = await app.get(GatewayKeyService).createKey(projectId, projectId, tenant.tenantId);
  return { tenant, projectId, key };
}

async function agentOfNewProject(): Promise<AgentFixture> {
  const tenant = await createTenant(app);
  return agentOf(tenant, await createProject(app, tenant));
}

async function reportLive(agent: AgentFixture, name: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${agent.key}` },
    payload: { live: true, name },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function askPublicUrl(agent: AgentFixture): Promise<unknown> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/gateway/app/public-url',
    headers: { authorization: `Bearer ${agent.key}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function editUrl(agent: AgentFixture, appSlug: string): Promise<void> {
  const owner = await addMember(app, agent.tenant, ['can_edit_app_details']);
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${agent.projectId}/app`,
    headers: owner.headers,
    payload: { environmentId: agent.projectId, appSlug },
  });
  expect(res.statusCode, res.body).toBe(200);
}

function shortIdOf(environmentId: string): string {
  return environmentId.replaceAll('-', '').slice(0, 12);
}

describe("the agent asking for its App's link", () => {
  it('hears nothing before the App goes live', async () => {
    const agent = await agentOfNewProject();

    expect(await askPublicUrl(agent)).toEqual({ publicUrl: null, servesAnExternalService: false });
  });

  it('hears the readable address once the App is live', async () => {
    const agent = await agentOfNewProject();
    await reportLive(agent, 'Equipment Monitor');

    expect(await askPublicUrl(agent)).toEqual({
      publicUrl: `https://equipment-monitor-dev-${shortIdOf(agent.projectId)}.${APPS}/`,
      servesAnExternalService: false,
    });
  });

  it('hears the current address after an Edit URL', async () => {
    const agent = await agentOfNewProject();
    await reportLive(agent, 'Equipment Monitor');

    await editUrl(agent, 'fleet');

    expect(await askPublicUrl(agent)).toEqual({
      publicUrl: `https://fleet-dev-${shortIdOf(agent.projectId)}.${APPS}/`,
      servesAnExternalService: false,
    });
  });

  it('hears that a Project serving an External Service has no public App', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Boards', 'boards');
    const agent = await agentOf(admin.tenant, service.builderChatId);
    await reportLive(agent, 'Boards');

    expect(await askPublicUrl(agent)).toEqual({ publicUrl: null, servesAnExternalService: true });
  });

  it('is refused without a Gateway Key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/gateway/app/public-url' });

    expect(res.statusCode).toBe(401);
  });
});

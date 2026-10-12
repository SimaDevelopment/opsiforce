import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { PodService } from '../../src/pod/pod.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectStatus } from '../../src/project/project.types';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService } from '../support/infra-fakes';
import {
  addMember,
  callTokenFor,
  createProject,
  createTenant,
  serviceKeyFor,
  stampProjectKind,
  type MemberFixture,
  type ProjectFixtureOptions,
  type TenantFixture,
} from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { saveProjectConfiguration } from './support/gate';

const CONTROL_TOKEN = 'proxy-control-token-for-runtime-proxy-tests';
const PUBLIC_API = 'public-api';

@Module({ controllers: [ProxyController] })
class ProxyTestModule {}

describe('a pod reaching a Project runtime through the runtime proxy', () => {
  let pod: FakePod;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let creator: MemberFixture;

  beforeAll(async () => {
    pod = await startFakePod();
    harness = await createExternalServicesTestApp({
      builtInsDir: shippedBuiltInServicesDir(),
      env: { AGENT_PORT: String(pod.port), PROXY_CONTROL_TOKEN: CONTROL_TOKEN },
      extraModules: [ProxyTestModule],
    });
    app = harness.app;
    tenant = await createTenant(app);
    creator = await addMember(app, tenant);
  });

  afterAll(async () => {
    await harness.close();
    await pod.stop().catch(() => undefined);
  });

  function ensure(environmentId: string, bearer: string) {
    return app.inject({
      method: 'POST',
      url: `/api/internal/proxy/projects/${environmentId}/ensure`,
      headers: { 'x-proxy-control-token': CONTROL_TOKEN, authorization: `Bearer ${bearer}` },
      payload: { surface: 'agent' },
    });
  }

  async function runningProject(options: ProjectFixtureOptions = {}): Promise<string> {
    const pods = app.get<PodService, FakePodService>(PodService);
    const environments = app.get(ProjectEnvironmentService);
    const projectId = await createProject(app, tenant, { createdBy: creator.userId, ...options });
    const podName = pods.assignedPodName(projectId);
    await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
    pods.markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);
    return projectId;
  }

  async function caller(connectProject: boolean): Promise<{ projectId: string; key: string }> {
    const projectId = await runningProject();
    await saveProjectConfiguration(app, PUBLIC_API, projectId, { operations: { connect_project: connectProject } });
    return { projectId, key: await serviceKeyFor(app, tenant, projectId) };
  }

  it('lets the service key reach a Project its Project created while connect_project is on', async () => {
    const { projectId, key } = await caller(true);
    const childId = await runningProject({ createdByProjectId: projectId });

    const res = await ensure(childId, key);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'ready' });
  });

  it('refuses while connect_project is off, as a new Project configuration has it', async () => {
    const projectId = await runningProject();
    const key = await serviceKeyFor(app, tenant, projectId);
    const childId = await runningProject({ createdByProjectId: projectId });

    const res = await ensure(childId, key);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('connect_project');
  });

  it('checks the switch live on every request', async () => {
    const { projectId, key } = await caller(true);
    const childId = await runningProject({ createdByProjectId: projectId });
    expect((await ensure(childId, key)).statusCode).toBe(201);

    await saveProjectConfiguration(app, PUBLIC_API, projectId, { operations: { connect_project: false } });
    expect((await ensure(childId, key)).statusCode).toBe(403);

    await saveProjectConfiguration(app, PUBLIC_API, projectId, { operations: { connect_project: true } });
    expect((await ensure(childId, key)).statusCode).toBe(201);
  });

  it('refuses a sibling Project its Project did not create', async () => {
    const { key } = await caller(true);
    const siblingId = await runningProject();

    expect((await ensure(siblingId, key)).statusCode).toBe(403);
  });

  it('lets a builder chat reach the Test Project it created', async () => {
    const { projectId: chatId, key } = await caller(true);
    await stampProjectKind(chatId, 'agent_builder_chat');
    const testProjectId = await runningProject({ createdByProjectId: chatId });
    await stampProjectKind(testProjectId, 'test');

    expect((await ensure(testProjectId, key)).statusCode).toBe(201);
  });

  it('refuses a key it does not know and a call token', async () => {
    const { projectId } = await caller(true);
    const childId = await runningProject({ createdByProjectId: projectId });

    expect((await ensure(childId, 'gw-unknown')).statusCode).toBe(401);
    expect((await ensure(childId, callTokenFor(app, tenant, projectId))).statusCode).toBe(401);
  });
});

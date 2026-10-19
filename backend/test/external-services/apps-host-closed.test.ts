import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PodService } from '../../src/pod/pod.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectStatus } from '../../src/project/project.types';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService } from '../support/infra-fakes';
import { createProject, createTenant, addMember } from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin } from './support/fixtures';

const CONTROL_TOKEN = 'proxy-control-token-for-apps-host-tests';

@Module({ controllers: [ProxyController] })
class ProxyTestModule {}

describe('the Apps host and External Services', () => {
  let pod: FakePod;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    pod = await startFakePod();
    harness = await createExternalServicesTestApp({
      env: { AGENT_PORT: String(pod.port), PROXY_CONTROL_TOKEN: CONTROL_TOKEN },
      extraModules: [ProxyTestModule],
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await pod.stop().catch(() => undefined);
  });

  function ensureApp(environmentId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/internal/proxy/projects/${environmentId}/ensure`,
      headers: { 'x-proxy-control-token': CONTROL_TOKEN },
      payload: { surface: 'app' },
    });
  }

  it("answers 404 for an External Service's Project, so its pod is reachable only through the Gate", async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Boards', 'boards');

    const res = await ensureApp(service.builderChatId);

    expect(res.statusCode, res.body).toBe(404);
  });

  it('still serves an ordinary Project', async () => {
    const tenant = await createTenant(app);
    const creator = await addMember(app, tenant);
    const pods = app.get<PodService, FakePodService>(PodService);
    const environments = app.get(ProjectEnvironmentService);
    const projectId = await createProject(app, tenant, { createdBy: creator.userId });
    const podName = pods.assignedPodName(projectId);
    await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
    pods.markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);

    const res = await ensureApp(projectId);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'ready' });
  });
});

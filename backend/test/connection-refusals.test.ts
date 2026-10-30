import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PodService } from '../src/pod/pod.service';
import { ProjectController } from '../src/project/project.controller';
import { ProjectStatus } from '../src/project/project.types';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { createPublicApiTestApp, type PublicApiTestApp } from './public-api/support/app';
import { podErrors, startFakePod, type FakePod } from './support/fake-pod';
import type { FakePodService } from './support/infra-fakes';
import {
  addMember,
  createProject,
  createTenant,
  disableProject,
  type MemberFixture,
  type TenantFixture,
} from './support/project-fixtures';
import { waitFor } from './support/wait-for';

@Module({ controllers: [ProjectController] })
class ProjectRoutes {}

const runtimeInfo = { version: '2.1.2', pid: 1, urls: [], paths: { tmp: '/tmp' } };

describe('refusing a connection on the internal connect route', () => {
  let pod: FakePod;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let pods: FakePodService;
  let environments: ProjectEnvironmentService;
  let tenant: TenantFixture;
  let member: MemberFixture;

  beforeAll(async () => {
    pod = await startFakePod();
    harness = await createPublicApiTestApp(
      {
        AGENT_PORT: String(pod.port),
        AGENT_WAKE_HOLD_MS: '600',
        AGENT_WAKE_POLL_MS: '100',
        AGENT_RUNTIME_REFUSAL_GRACE_MS: '100',
      },
      [ProjectRoutes]
    );
    app = harness.app;
    pods = app.get<PodService, FakePodService>(PodService);
    environments = app.get(ProjectEnvironmentService);
    tenant = await createTenant(app);
    member = await addMember(app, tenant);
  });

  afterAll(async () => {
    await harness.close();
    await pod.stop().catch(() => undefined);
  });

  beforeEach(() => {
    pod.clearScripts();
    pod.setInfo({ status: 200, body: runtimeInfo });
  });

  async function runningProject(): Promise<string> {
    const projectId = await createProject(app, tenant);
    const podName = pods.assignedPodName(projectId);
    await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
    pods.markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);
    return projectId;
  }

  async function connect(projectId: string): Promise<{ status: number; code: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/environments/${projectId}/connect`,
      headers: member.headers,
    });
    return { status: res.statusCode, code: res.json<{ code?: unknown }>().code };
  }

  it('answers an environment still starting when the budget runs out with a 503 the client waits out', async () => {
    const projectId = await runningProject();
    await pods.deletePod(pods.assignedPodName(projectId));
    await environments.patch(projectId, { status: ProjectStatus.Starting });

    expect(await connect(projectId)).toEqual({ status: 503, code: 'environment_starting' });
  });

  it('names a disabled environment', async () => {
    const projectId = await runningProject();
    await disableProject(projectId);

    expect(await connect(projectId)).toEqual({ status: 409, code: 'environment_disabled' });
  });

  it('names a failed environment', async () => {
    const projectId = await runningProject();
    await environments.patch(projectId, { status: ProjectStatus.Failed });

    expect(await connect(projectId)).toEqual({ status: 409, code: 'environment_failed' });
  });

  it('answers starting while it replaces a ready pod whose runtime refuses to identify itself', async () => {
    const projectId = await runningProject();
    const deleted = pods.callsTo('deletePod').length;
    pod.setInfo({ status: 503, body: runtimeInfo });

    expect(await connect(projectId)).toEqual({ status: 503, code: 'environment_starting' });
    expect(pods.callsTo('deletePod').length - deleted).toBe(1);
  });

  it('answers 500 unexpected, as the public API does, when the runtime rejects a request without failing', async () => {
    const projectId = await runningProject();
    pod.script('session.list', { status: 400, body: podErrors.invalidRequest('bad cursor', 'cursor'), once: true });

    expect(await connect(projectId)).toEqual({ status: 500, code: 'unexpected' });
  });

  it('answers 502 when the pod cannot be reached', async () => {
    const projectId = await runningProject();
    await pod.stop();

    expect(await connect(projectId)).toEqual({ status: 502, code: 'agent_unreachable' });
  });
});

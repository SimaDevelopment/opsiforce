import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../src/gateway/gateway-key.service';
import { PodService } from '../src/pod/pod.service';
import { AgentStatusStreamController } from '../src/project/agent-status-stream.controller';
import { ProjectService } from '../src/project/project.service';
import { ProjectStatus } from '../src/project/project.types';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { openAgentStatusStream, type AgentStatusStream } from './support/agent-status-stream';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/external-services-app';
import type { FakePodService } from './support/infra-fakes';
import {
  addMember,
  addNamedEnvironment,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from './support/project-fixtures';
import { waitFor } from './support/wait-for';

@Module({ controllers: [AgentStatusStreamController] })
class AgentStatusStreamRoute {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  harness = await createExternalServicesTestApp({ extraModules: [AgentStatusStreamRoute] });
  app = harness.app;
  baseUrl = await harness.listen();
});

afterAll(async () => {
  await harness?.close();
});

interface RunningProject {
  tenant: TenantFixture;
  member: MemberFixture;
  projectId: string;
}

interface Pod {
  environmentId: string;
  key: string;
}

function podStarts(environmentId: string): number {
  const pods = app.get<typeof PodService, FakePodService>(PodService);
  const podName = pods.assignedPodName(environmentId);
  return pods.callsTo('waitForReady').filter((call) => call.args.podName === podName).length;
}

async function podComesUp(environmentId: string, startsBefore: number): Promise<void> {
  const pods = app.get<typeof PodService, FakePodService>(PodService);
  await waitFor(() => podStarts(environmentId) > startsBefore);
  pods.markPodReady(pods.assignedPodName(environmentId), '127.0.0.1');
  await waitFor(
    async () =>
      (await app.get(ProjectEnvironmentService).findByIdOrNull(environmentId))?.status === ProjectStatus.Active
  );
}

async function runningProject(): Promise<RunningProject> {
  const tenant = await createTenant(app);
  const member = await addMember(app, tenant);
  const projectId = await createProject(app, tenant);
  await podComesUp(projectId, 0);
  return { tenant, member, projectId };
}

async function podOf(project: RunningProject, environmentId = project.projectId): Promise<Pod> {
  const key = await app.get(GatewayKeyService).createKey(project.projectId, environmentId, project.tenant.tenantId);
  return { environmentId, key };
}

async function report(pod: Pod, state: { serving: boolean; live?: boolean; name?: string }): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${pod.key}` },
    payload: state,
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function servingEdgesOf(stream: AgentStatusStream, pod: Pod, count: number): Promise<boolean[]> {
  await waitFor(() => stream.servingOf(pod.environmentId).length >= count);
  return stream.servingOf(pod.environmentId);
}

describe('App serving edges on the agent-status stream', () => {
  it('tells the workspace each time the App stops and starts answering', async () => {
    const project = await runningProject();
    const pod = await podOf(project);
    const stream = await openAgentStatusStream(baseUrl, project.member.headers);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await report(pod, { serving: true });
    await report(pod, { serving: false });
    await report(pod, { serving: true });

    expect(await servingEdgesOf(stream, pod, 3)).toEqual([true, false, true]);
    expect(stream.appEvents[0]).toEqual({
      projectId: project.projectId,
      environmentId: pod.environmentId,
      serving: true,
    });
    stream.close();
  });

  it('sends nothing more while the App keeps serving, whatever else the pod reports', async () => {
    const project = await runningProject();
    const pod = await podOf(project);
    const stream = await openAgentStatusStream(baseUrl, project.member.headers);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await report(pod, { serving: true });
    await report(pod, { serving: true, live: true, name: 'Equipment Monitor' });
    await report(pod, { serving: true, live: true, name: 'Equipment Monitor' });
    await report(pod, { serving: false });

    expect(await servingEdgesOf(stream, pod, 2)).toEqual([true, false]);
    stream.close();
  });

  it('says nothing about an App that was already serving when the workspace opened', async () => {
    const project = await runningProject();
    const pod = await podOf(project);
    await report(pod, { serving: true });

    const stream = await openAgentStatusStream(baseUrl, project.member.headers);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);
    await report(pod, { serving: false });

    expect(await servingEdgesOf(stream, pod, 1)).toEqual([false]);
    stream.close();
  });

  it('reports the App coming back on the pod a restart recreated', async () => {
    const project = await runningProject();
    const pod = await podOf(project);
    const stream = await openAgentStatusStream(baseUrl, project.member.headers);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);
    await report(pod, { serving: true });
    await servingEdgesOf(stream, pod, 1);

    const startsBefore = podStarts(pod.environmentId);
    await app.get(ProjectService).restart(project.projectId, project.tenant.tenantId);
    await podComesUp(pod.environmentId, startsBefore);
    await report(pod, { serving: true });

    expect(await servingEdgesOf(stream, pod, 3)).toEqual([true, false, true]);
    stream.close();
  });

  it('names the environment whose App came up', async () => {
    const project = await runningProject();
    const development = await podOf(project);
    const staging = await podOf(project, await addNamedEnvironment(app, project.tenant, project.projectId, 'Staging'));
    const stream = await openAgentStatusStream(baseUrl, project.member.headers);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await report(staging, { serving: true });
    await report(development, { serving: true });

    await waitFor(() => stream.appEvents.length === 2);
    expect(stream.appEvents.map((event) => [event.environmentId, event.serving])).toEqual([
      [staging.environmentId, true],
      [development.environmentId, true],
    ]);
    stream.close();
  });
});

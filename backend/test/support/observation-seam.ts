import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GatewayAuthGuard } from '../../src/gateway/gateway-auth.guard';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { PodService } from '../../src/pod/pod.service';
import { AgentObservationsController } from '../../src/project/agent-observations.controller';
import { AGENT_STATUS_TIMER } from '../../src/project/agent-status.service';
import { AgentStatusStreamController } from '../../src/project/agent-status-stream.controller';
import { ProjectStatus } from '../../src/project/project.types';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { TimeoutService } from '../../src/timeout/timeout.service';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';
import { startFakePod, type FakePod } from './fake-pod';
import type { FakePodService, FakeTimeoutService, FakeTimer } from './infra-fakes';
import { addMember, createProject, createTenant, type MemberFixture, type TenantFixture } from './project-fixtures';
import { waitFor } from './wait-for';

@Module({
  controllers: [AgentObservationsController, AgentStatusStreamController],
  providers: [GatewayAuthGuard],
})
class ObservationRoutesModule {}

export interface ObservedProject {
  tenant: TenantFixture;
  member: MemberFixture;
  projectId: string;
  environmentId: string;
  gatewayKey: string;
}

export interface AgentStatusEvent {
  projectId: string;
  agentStatus: string;
}

export interface EnvironmentStatusEvent extends AgentStatusEvent {
  environmentId: string;
}

export interface AgentStatusStream {
  events: AgentStatusEvent[];
  environmentEvents: EnvironmentStatusEvent[];
  statusesOf: (projectId: string) => string[];
  environmentStatusesOf: (environmentId: string) => string[];
  close: () => void;
}

export interface ObservationSeam {
  app: NestFastifyApplication;
  pod: FakePod;
  rereadClock: FakeTimer;
  timeouts: FakeTimeoutService;
  reset: () => Promise<void>;
  createRunningProject: () => Promise<ObservedProject>;
  observe: (gatewayKey: string | null, body: unknown) => ReturnType<NestFastifyApplication['inject']>;
  runStarted: (project: ObservedProject, sessionId: string) => ReturnType<NestFastifyApplication['inject']>;
  runEnded: (project: ObservedProject, sessionId: string) => ReturnType<NestFastifyApplication['inject']>;
  agentStatusOf: (project: ObservedProject) => Promise<string>;
  openAgentStatusStream: (member: MemberFixture) => Promise<AgentStatusStream>;
  close: () => Promise<void>;
}

export async function createObservationSeam(): Promise<ObservationSeam> {
  const pod = await startFakePod();
  let harness: PublicApiTestApp;
  try {
    harness = await createPublicApiTestApp({ AGENT_PORT: String(pod.port) }, [ObservationRoutesModule]);
  } catch (error) {
    await pod.stop();
    throw error;
  }
  const { app } = harness;
  const baseUrl = await harness.listen();
  const pods = app.get<typeof PodService, FakePodService>(PodService);
  const rereadClock = app.get<string, FakeTimer>(AGENT_STATUS_TIMER);
  const streams = new Set<AgentStatusStream>();

  async function reset(): Promise<void> {
    pod.clearScripts();
    pod.setActive([]);
    await rereadClock.elapse();
  }

  async function markNextPodReady(environmentId: string, readyBefore: number): Promise<void> {
    await waitFor(() => pods.callsTo('waitForReady').length > readyBefore);
    pods.markPodReady(pods.assignedPodName(environmentId), '127.0.0.1');
    await waitFor(
      async () =>
        (await app.get(ProjectEnvironmentService).findByIdOrNull(environmentId))?.status === ProjectStatus.Active
    );
  }

  async function createRunningProject(): Promise<ObservedProject> {
    const tenant = await createTenant(app);
    const member = await addMember(app, tenant);
    const readyBefore = pods.callsTo('waitForReady').length;
    const projectId = await createProject(app, tenant, { title: 'Observed' });
    const environmentId = projectId;
    await markNextPodReady(environmentId, readyBefore);
    const gatewayKey = await app.get(GatewayKeyService).createKey(projectId, environmentId, tenant.tenantId);
    return { tenant, member, projectId, environmentId, gatewayKey };
  }

  function observe(gatewayKey: string | null, body: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/gateway/agent/observations',
      headers: gatewayKey === null ? {} : { authorization: `Bearer ${gatewayKey}` },
      payload: body as object,
    });
  }

  function runStarted(project: ObservedProject, sessionId: string) {
    return observe(project.gatewayKey, { kind: 'run.started', sessionId });
  }

  function runEnded(project: ObservedProject, sessionId: string) {
    return observe(project.gatewayKey, { kind: 'run.ended', sessionId });
  }

  async function agentStatusOf(project: ObservedProject): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.projectId}`,
      headers: project.member.headers,
    });
    if (res.statusCode !== 200) throw new Error(`GET project answered ${res.statusCode}: ${res.body}`);
    return res.json<{ agentStatus: string }>().agentStatus;
  }

  async function openAgentStatusStream(member: MemberFixture): Promise<AgentStatusStream> {
    const aborter = new AbortController();
    const res = await fetch(`${baseUrl}/api/agent-status/events`, { headers: member.headers, signal: aborter.signal });
    if (!res.ok || !res.body) throw new Error(`agent-status stream answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events: AgentStatusEvent[] = [];
    const environmentEvents: EnvironmentStatusEvent[] = [];
    let buffered = '';

    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const lines = frame.split('\n');
          const name = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
          const data = lines
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n');
          if (data && name === 'environment') environmentEvents.push(JSON.parse(data) as EnvironmentStatusEvent);
          else if (data) events.push(JSON.parse(data) as AgentStatusEvent);
          boundary = buffered.indexOf('\n\n');
        }
      }
    })().catch(() => undefined);

    const stream: AgentStatusStream = {
      events,
      environmentEvents,
      statusesOf: (projectId) => events.filter((event) => event.projectId === projectId).map((e) => e.agentStatus),
      environmentStatusesOf: (environmentId) =>
        environmentEvents.filter((event) => event.environmentId === environmentId).map((e) => e.agentStatus),
      close: () => {
        aborter.abort();
        streams.delete(stream);
      },
    };
    streams.add(stream);
    return stream;
  }

  return {
    app,
    pod,
    rereadClock,
    timeouts: app.get<typeof TimeoutService, FakeTimeoutService>(TimeoutService),
    reset,
    createRunningProject,
    observe,
    runStarted,
    runEnded,
    agentStatusOf,
    openAgentStatusStream,
    close: async () => {
      for (const stream of streams) stream.close();
      try {
        await harness.close();
      } finally {
        await pod.stop().catch(() => undefined);
      }
    },
  };
}

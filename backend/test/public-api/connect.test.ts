import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { callerIdentityHeader } from '@opsiforce/external-service-sdk/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import { PodService } from '../../src/pod/pod.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectStatus } from '../../src/project/project.types';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { OPENCODE_DESCRIPTOR_FIELDS } from './support/dto-fields';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService } from '../support/infra-fakes';
import {
  addMember,
  callerIdentityFor,
  createTenant,
  createProject,
  createSharedWorkspace,
  disableProject,
  type MemberFixture,
  type ProjectFixtureOptions,
  type TenantFixture,
} from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';

const RUNTIME_PROXY_URL = 'http://runtime-proxy.test';

describe('connecting to an environment', () => {
  let pod: FakePod;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let pods: FakePodService;
  let environments: ProjectEnvironmentService;
  let tenant: TenantFixture;
  let member: MemberFixture;

  beforeAll(async () => {
    pod = await startFakePod();
    harness = await createPublicApiTestApp({
      AGENT_PORT: String(pod.port),
      AGENT_WAKE_HOLD_MS: '600',
      AGENT_WAKE_POLL_MS: '100',
      OPSIFORCE_RUNTIME_PROXY_URL: `${RUNTIME_PROXY_URL}/`,
    });
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
    pod.sessions.clear();
    pod.clearScripts();
    pod.setInfo({ status: 200, body: { version: '2.1.2', pid: 1, urls: [], paths: { tmp: '/tmp' } } });
  });

  async function runningProject(options: ProjectFixtureOptions = {}): Promise<string> {
    const projectId = await createProject(app, tenant, options);
    const podName = pods.assignedPodName(projectId);
    await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
    pods.markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);
    return projectId;
  }

  function connect(projectId: string, environmentId: string, headers: Record<string, string> = member.headers) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/environments/${environmentId}/connect`,
      headers,
    });
  }

  function getProject(projectId: string, headers: Record<string, string> = member.headers) {
    return app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers });
  }

  describe('the discovery a Project carries', () => {
    it('is origin-relative for a person and needs no pod call, wake or build column', async () => {
      const projectId = await runningProject();
      const podCalls = pod.requests.length;
      const podsCreated = pods.callsTo('createAssignedPod').length;

      const res = await getProject(projectId);

      expect(res.statusCode).toBe(200);
      const [environment] = res.json().environments;
      expect(Object.keys(environment.opencode)).toEqual(OPENCODE_DESCRIPTOR_FIELDS);
      expect(environment.opencode).toMatchObject({
        baseUrl: `/api/proxy/${projectId}`,
        openapiUrl: `/api/proxy/${projectId}/openapi.json`,
      });
      expect(environment.opencode).not.toHaveProperty('build');
      expect(pod.requests).toHaveLength(podCalls);
      expect(pods.callsTo('createAssignedPod')).toHaveLength(podsCreated);
    });

    it('reports the remembered Session, null before anything has bound one', async () => {
      const projectId = await runningProject();

      const before = await getProject(projectId);
      expect(before.json().environments[0].opencode.sessionId).toBeNull();

      const connected = await connect(projectId, projectId);
      expect(connected.statusCode).toBe(200);

      const after = await getProject(projectId);
      expect(after.json().environments[0].opencode.sessionId).toBe(connected.json().sessionId);
    });
  });

  describe('a successful connection', () => {
    it('answers with a usable descriptor and the observed build', async () => {
      const projectId = await runningProject();

      const res = await connect(projectId, projectId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        baseUrl: `/api/proxy/${projectId}`,
        openapiUrl: `/api/proxy/${projectId}/openapi.json`,
        sessionId: expect.stringMatching(/^ses_/),
        build: '2.1.2',
      });
    });

    it('reports a null build when the runtime identifies none', async () => {
      const projectId = await runningProject();
      pod.setInfo({ status: 200, body: { pid: 1, urls: [], paths: { tmp: '/tmp' } } });

      expect((await connect(projectId, projectId)).json().build).toBeNull();
    });
  });

  describe('a Project another Project created', () => {
    it('gives the creating Project absolute runtime URLs on the runtime proxy, connected or read', async () => {
      const callingProjectId = await createProject(app, tenant, { createdBy: member.userId });
      const projectId = await runningProject({ createdBy: member.userId, createdByProjectId: callingProjectId });
      const asCallingProject = { [callerIdentityHeader]: callerIdentityFor(app, tenant, callingProjectId) };
      const runtime = {
        baseUrl: `${RUNTIME_PROXY_URL}/api/proxy/${projectId}`,
        openapiUrl: `${RUNTIME_PROXY_URL}/api/proxy/${projectId}/openapi.json`,
      };

      const connected = await connect(projectId, projectId, asCallingProject);
      const read = await getProject(projectId, asCallingProject);
      const readByPerson = await getProject(projectId);

      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toMatchObject(runtime);
      expect(read.json().environments[0].opencode).toMatchObject(runtime);
      expect(readByPerson.json().environments[0].opencode.baseUrl).toBe(`/api/proxy/${projectId}`);
    });
  });

  describe('resources the caller may not touch', () => {
    it('answers not found for an environment of another Project', async () => {
      const own = await runningProject();
      const other = await runningProject();
      const podCalls = pod.requests.length;

      const res = await connect(own, other);

      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe('urn:opsiforce:error:project-not-found');
      expect(pod.requests).toHaveLength(podCalls);
    });

    it('answers not found for a Project the caller cannot see', async () => {
      const owner = await addMember(app, tenant);
      const workspaceId = await createSharedWorkspace(app, tenant, owner);
      const projectId = await runningProject({ workspaceId });
      const podCalls = pod.requests.length;

      const res = await connect(projectId, projectId);

      expect(res.statusCode).toBe(404);
      expect(pod.requests).toHaveLength(podCalls);
    });

    it('answers not found for an environment that never existed', async () => {
      const projectId = await runningProject();

      expect((await connect(projectId, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    });
  });

  describe('environments that cannot serve a connection', () => {
    it('reports a disabled environment as locked', async () => {
      const projectId = await runningProject();
      await disableProject(projectId);

      const res = await connect(projectId, projectId);

      expect(res.statusCode).toBe(423);
      expect(res.json().type).toBe('urn:opsiforce:error:environment-disabled');
    });

    it('reports a failed environment', async () => {
      const projectId = await runningProject();
      await db
        .update(projectEnvironments)
        .set({ status: ProjectStatus.Failed })
        .where(eq(projectEnvironments.id, projectId));

      const res = await connect(projectId, projectId);

      expect(res.statusCode).toBe(503);
      expect(res.json().type).toBe('urn:opsiforce:error:environment-failed');
    });

    it('reports a still-starting environment with retry guidance once the budget expires', async () => {
      const projectId = await runningProject();
      await pods.deletePod(pods.assignedPodName(projectId));
      await db
        .update(projectEnvironments)
        .set({ status: ProjectStatus.Starting })
        .where(eq(projectEnvironments.id, projectId));

      const res = await connect(projectId, projectId);

      expect(res.statusCode).toBe(503);
      expect(res.json().type).toBe('urn:opsiforce:error:environment-starting');
      expect(res.headers['retry-after']).toBe('5');
    });
  });
});

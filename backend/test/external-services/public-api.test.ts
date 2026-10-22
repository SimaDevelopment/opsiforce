import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mintCallerIdentity, callerIdentityHeader } from '@opsiforce/external-service-sdk/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { projects } from '../../db/schema';
import { builtInCallerKey } from '../../src/external-services/built-ins/built-in-caller-key';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import {
  MAX_CREATED_PROJECTS,
  PUBLIC_API_SWITCHES,
  PublicApiSettings,
} from '../../src/external-services/configuration/public-api-settings';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { Perms } from '../../src/permission/permission.constants';
import { ProjectEventsService } from '../../src/project/project-events.service';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { seedLiveAgent } from '../support/agent-fixtures';
import type { FakeProjectEventsService } from '../support/infra-fakes';
import {
  addMember,
  clearProjectCreator,
  createProject,
  createTenant,
  removeMemberFromTenant,
  serviceKeyFor,
  setMemberPermissions,
  stampProjectKind,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { TENANT_SERVICES } from './support/custom-services';
import { builtInServiceId } from './support/fixtures';
import { callThroughGate } from './support/gate-proxy';
import { saveProjectConfiguration } from './support/gate';

const PUBLIC_API = 'public-api';

const WHO_CHANGES_IT = "Someone who can configure this Project's External Services can change it.";

const READS = [
  'GET /api/v1/agents',
  'GET /api/v1/agents/:id',
  'GET /api/v1/agents/:id/skills',
  'GET /api/v1/me',
  'GET /api/v1/projects',
  'GET /api/v1/projects/:id',
  'GET /api/v1/skills',
  'GET /api/v1/skills/:id',
  'GET /api/v1/skills/:id/versions/:version/files',
  'POST /api/v1/skills/validate',
];

const WRITES: Record<string, string[]> = {
  authorSkillsAndAgents: [
    'PATCH /api/v1/agents/:id',
    'PUT /api/v1/agents/:id/profile',
    'PUT /api/v1/agents/:id/template',
    'PUT /api/v1/agents/:id/skills/:skillId',
    'DELETE /api/v1/agents/:id/skills/:skillId',
    'POST /api/v1/skills',
    'PATCH /api/v1/skills/:id',
    'POST /api/v1/skills/:id/versions',
    'POST /api/v1/skills/:id/duplicate',
  ],
  createAgents: ['POST /api/v1/agents'],
  createProjects: ['POST /api/v1/projects'],
  driveCreatedProjects: [
    'POST /api/v1/projects/:id/environments/:environmentId/connect',
    'POST /api/v1/projects/:id/restart',
    'POST /api/v1/projects/:id/test/update',
    'POST /api/v1/projects/:id/test/reset',
  ],
  deleteCreatedProjects: ['DELETE /api/v1/projects/:id'],
};

const ALL_OFF = {
  authorSkillsAndAgents: false,
  createAgents: false,
  createProjects: false,
  maxCreatedProjects: 5,
  driveCreatedProjects: false,
  deleteCreatedProjects: false,
};

interface Pod {
  projectId: string;
  key: string;
}

interface DescribedRoute {
  route: string;
  allowedBy?: string[];
  allowAll?: true;
}

describe('the Public API on its Service host', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let admin: MemberFixture;
  let agentId: string;

  async function pod(createdByProjectId?: string): Promise<Pod> {
    const projectId = await createProject(app, tenant, { agentId, createdBy: creator.userId, createdByProjectId });
    return { projectId, key: await serviceKeyFor(app, tenant, projectId) };
  }

  async function connectedPod(settings: Partial<typeof ALL_OFF> = {}, createdByProjectId?: string): Promise<Pod> {
    const caller = await pod(createdByProjectId);
    await saveProjectConfiguration(app, PUBLIC_API, caller.projectId, { ...ALL_OFF, ...settings });
    return caller;
  }

  function call(caller: Pod, method: string, path: string, body?: unknown): Promise<Response> {
    return callThroughGate(app, { credential: `Bearer ${caller.key}`, slug: PUBLIC_API }, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
  }

  function createProjectAs(caller: Pod, title: string): Promise<Response> {
    return call(caller, 'POST', '/api/v1/projects', { title, agentId });
  }

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    app = harness.app;
    await harness.listen();
    tenant = await createTenant(app);
    creator = await addMember(app, tenant, [Perms.deleteProject]);
    admin = await addMember(app, tenant, [Perms.manageTenantExternalServices]);
    agentId = (await seedLiveAgent(tenant.tenantId, creator.userId)).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers the real /api/v1 paths as the human who created the calling Project', async () => {
    const caller = await connectedPod();

    const res = await call(caller, 'GET', '/api/v1/me');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: creator.userId,
      source: 'caller-identity',
      tenant: { id: tenant.tenantId, name: tenant.name },
    });
  });

  it('refuses a Project with no public-api configuration as not connected, in the API’s problem shape', async () => {
    const caller = await pod();

    const res = await call(caller, 'GET', '/api/v1/me');

    expect(res.status).toBe(403);
    expect(res.headers.get('opsiforce-outcome')).toBe('not connected');
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await res.json();
    expect(problem).toMatchObject({ type: 'urn:opsiforce:error:permission-denied', status: 403 });
    expect(problem.detail).toContain(`/projects/${caller.projectId}?configure=public-api`);
    expect(problem.detail).toContain(WHO_CHANGES_IT);
  });

  describe('which routes a Caller identity reaches', () => {
    it('describes exactly the 26 decorated routes, reads open to every connected Project and each write behind one setting', async () => {
      const caller = await connectedPod();

      const res = await call(caller, 'GET', '/.well-known/opsiforce');

      expect(res.status).toBe(200);
      const routes = ((await res.json()) as { routes: DescribedRoute[] }).routes;
      expect(routes).toHaveLength(26);
      for (const read of READS) {
        expect(routes.find((entry) => entry.route === read)).toMatchObject({ allowedBy: [], allowAll: true });
      }
      for (const [setting, writes] of Object.entries(WRITES)) {
        for (const write of writes) {
          expect(routes.find((entry) => entry.route === write)).toMatchObject({ allowedBy: [setting] });
        }
      }
    });

    it('answers not supported to an undecorated route, without running it', async () => {
      const caller = await connectedPod({ authorSkillsAndAgents: true });
      const project = await pod(caller.projectId);

      const res = await call(caller, 'POST', `/api/v1/agents/${project.projectId}/publish`);

      expect(res.status).toBe(404);
      expect(res.headers.get('opsiforce-outcome')).toBe('not supported');
      expect(await res.json()).toMatchObject({ type: 'urn:opsiforce:error:route-not-found' });
    });
  });

  describe('the five settings', () => {
    const probes: Record<string, { method: string; path: (id: string) => string; body?: unknown; label: string }> = {
      authorSkillsAndAgents: {
        method: 'PATCH',
        path: () => `/api/v1/skills/${randomUUID()}`,
        body: { displayName: 'Renamed' },
        label: 'Edit Agents and Skills',
      },
      createAgents: { method: 'POST', path: () => '/api/v1/agents', body: {}, label: 'Create Agents' },
      createProjects: { method: 'POST', path: () => '/api/v1/projects', body: {}, label: 'Create Projects' },
      driveCreatedProjects: {
        method: 'POST',
        path: (id) => `/api/v1/projects/${id}/restart`,
        label: 'Manage created Projects',
      },
      deleteCreatedProjects: {
        method: 'DELETE',
        path: () => `/api/v1/projects/${randomUUID()}`,
        label: 'Delete created Projects',
      },
    };

    for (const [setting, probe] of Object.entries(probes)) {
      it(`refuses ${setting} while it is off, naming the setting, its link and who changes it`, async () => {
        const caller = await connectedPod();

        const res = await call(caller, probe.method, probe.path(caller.projectId), probe.body);

        expect(res.status).toBe(403);
        expect(res.headers.get('opsiforce-outcome')).toBe('not allowed');
        expect(res.headers.get('opsiforce-setting')).toBe(setting);
        const problem = await res.json();
        expect(problem.type).toBe('urn:opsiforce:error:permission-denied');
        expect(problem.detail).toContain(`Setting "${probe.label}"`);
        expect(problem.detail).toContain(`configure=public-api&field=${setting}`);
        expect(problem.detail).toContain(WHO_CHANGES_IT);
      });

      it(`lets the API answer once ${setting} is on`, async () => {
        const caller = await connectedPod({ [setting]: true });

        const res = await call(caller, probe.method, probe.path(caller.projectId), probe.body);

        expect(res.headers.get('opsiforce-outcome')).toBeNull();
        expect(res.status).not.toBe(403);
        await res.text();
      });
    }
  });

  it("knows every setting of the service's Project form, labelled as the form labels it", () => {
    const manifest = app.get(ServiceRegistry).bySlug('public-api')?.manifest;
    const keys = (manifest?.projectForm ?? []).flatMap((field) =>
      'key' in field && field.type !== 'info' ? [field.key] : []
    );

    expect(keys.toSorted()).toEqual([...PUBLIC_API_SWITCHES, MAX_CREATED_PROJECTS].toSorted());
    expect(app.get(PublicApiSettings).labelOf(MAX_CREATED_PROJECTS)).toBe(
      'Opsiforce Public API → Created Projects limit'
    );
  });

  describe('Created Projects limit', () => {
    it('refuses the next Project at the cap with 409 naming the setting and who can raise it', async () => {
      const caller = await connectedPod({ createProjects: true, maxCreatedProjects: 2 });
      for (const title of ['First', 'Second']) {
        const created = await createProjectAs(caller, title);
        expect(created.status, await created.text()).toBe(201);
      }

      const refused = await createProjectAs(caller, 'Third');

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        type: 'urn:opsiforce:error:max-created-projects',
        detail:
          "This Project may create at most 2 Projects (Opsiforce Public API → Created Projects limit). Delete one you created, or ask someone who can configure this Project's External Services to raise it.",
      });
    });

    it('lets parallel creates through only up to the cap', async () => {
      const caller = await connectedPod({ createProjects: true, maxCreatedProjects: 2 });

      const answers = await Promise.all(
        ['One', 'Two', 'Three', 'Four', 'Five'].map((title) => createProjectAs(caller, title))
      );

      expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 201, 409, 409, 409]);
      const created = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.createdByProjectId, caller.projectId));
      expect(created).toHaveLength(2);
    });

    it('counts every created Project still there, a disabled one and a Test Project included', async () => {
      const caller = await connectedPod({ createProjects: true, maxCreatedProjects: 2 });
      const disabled = await pod(caller.projectId);
      await db.update(projects).set({ disabled: true }).where(eq(projects.id, disabled.projectId));
      const test = await pod(caller.projectId);
      await stampProjectKind(test.projectId, 'test');

      const refused = await createProjectAs(caller, 'Over the cap');

      expect(refused.status).toBe(409);
    });

    it('frees a slot when a created Project is deleted', async () => {
      const caller = await connectedPod({ createProjects: true, maxCreatedProjects: 1, deleteCreatedProjects: true });
      const first = await createProjectAs(caller, 'Only one');
      expect(first.status).toBe(201);
      expect((await createProjectAs(caller, 'Refused')).status).toBe(409);

      const deleted = await call(caller, 'DELETE', `/api/v1/projects/${(await first.json()).id}`);
      expect(deleted.status, await deleted.text()).toBe(204);

      const again = await createProjectAs(caller, 'In the freed slot');
      expect(again.status, await again.text()).toBe(201);
    });

    it('leaves the depth-2 chain stop in place', async () => {
      const root = await pod();
      const child = await pod(root.projectId);
      const grandchild = await connectedPod({ createProjects: true }, child.projectId);

      const res = await createProjectAs(grandchild, 'Too deep');

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ type: 'urn:opsiforce:error:chain-too-deep' });
    });
  });

  describe('who the call acts as', () => {
    it("carries the creator's permissions as they stand at each call", async () => {
      const caller = await connectedPod({ deleteCreatedProjects: true });
      const target = (await pod(caller.projectId)).projectId;

      await setMemberPermissions(tenant, creator, []);
      const refused = await call(caller, 'DELETE', `/api/v1/projects/${target}`);
      await setMemberPermissions(tenant, creator, [Perms.deleteProject]);
      const allowed = await call(caller, 'DELETE', `/api/v1/projects/${target}`);

      expect(refused.status).toBe(403);
      expect(refused.headers.get('opsiforce-outcome')).toBeNull();
      expect(await refused.json()).toMatchObject({ type: 'urn:opsiforce:error:permission-denied' });
      expect(allowed.status, await allowed.text()).toBe(204);
    });

    it('refuses a Project that records no creator', async () => {
      const caller = await connectedPod();
      await clearProjectCreator(caller.projectId);

      const res = await call(caller, 'GET', '/api/v1/me');

      expect(await res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });

    it('refuses a creator who no longer belongs to the Organization', async () => {
      const leaver = await addMember(app, tenant);
      const projectId = await createProject(app, tenant, { agentId, createdBy: leaver.userId });
      await saveProjectConfiguration(app, PUBLIC_API, projectId, ALL_OFF);
      const caller = { projectId, key: await serviceKeyFor(app, tenant, projectId) };
      await removeMemberFromTenant(leaver);

      const res = await call(caller, 'GET', '/api/v1/me');

      expect(await res.json()).toMatchObject({ type: 'urn:opsiforce:error:tenant-forbidden' });
    });

    it('lists only the Projects its Project created', async () => {
      const caller = await connectedPod();
      const own = (await pod(caller.projectId)).projectId;
      const { projectId: foreign } = await pod();

      const res = await call(caller, 'GET', '/api/v1/projects');

      const ids = ((await res.json()) as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(own);
      expect(ids).not.toContain(foreign);
      expect(ids).not.toContain(caller.projectId);
    });
  });

  describe('records', () => {
    it('writes Caller-identity calls to the built-ins Call log and counts projects_created, but not a human’s calls', async () => {
      const serviceId = await builtInServiceId(PUBLIC_API);
      const caller = await connectedPod({ createProjects: true });
      expect((await createProjectAs(caller, 'Counted')).status).toBe(201);
      const human = await app.inject({ method: 'GET', url: '/api/v1/me', headers: creator.headers });
      expect(human.statusCode).toBe(403);

      const page = await vi.waitFor(async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/external-services/projects/${caller.projectId}/environments/${caller.projectId}/services/${serviceId}/call-log`,
          headers: admin.headers,
        });
        expect(res.statusCode, res.body).toBe(200);
        const calls = res.json().calls as unknown[];
        expect(calls).toHaveLength(1);
        return res.json();
      });
      expect(page.calls[0]).toMatchObject({
        callerKind: 'call',
        method: 'POST',
        path: '/api/v1/projects',
        route: 'Create a Project',
        outcome: 'handled',
        status: 201,
      });
      await vi.waitFor(async () => {
        const res = await app.inject({
          method: 'GET',
          url: `${TENANT_SERVICES}/${serviceId}/usage`,
          headers: admin.headers,
        });
        const view = res.json();
        expect(
          view.projects.find((project: { projectId: string }) => project.projectId === caller.projectId)?.values
        ).toMatchObject({ requests: 1, projects_created: 1 });
        expect(view.counters).toContainEqual(
          expect.objectContaining({ name: 'projects_created', label: 'Projects created' })
        );
      });
    });
  });

  describe('waking the page that watches the calling Project', () => {
    let events: FakeProjectEventsService;

    beforeEach(async () => {
      events = app.get(ProjectEventsService) as unknown as FakeProjectEventsService;
      await new Promise((resolve) => setImmediate(resolve));
      events.calls.length = 0;
    });

    it('publishes on the calling Project after a write', async () => {
      const caller = await connectedPod({ createProjects: true });

      const res = await createProjectAs(caller, 'Wakes the page');

      expect(res.status, await res.text()).toBe(201);
      expect(events.callsTo('publish').map((entry) => entry.args.projectId)).toContain(caller.projectId);
    });

    it('stays quiet on a read', async () => {
      const caller = await connectedPod();
      await new Promise((resolve) => setImmediate(resolve));
      events.calls.length = 0;

      const res = await call(caller, 'GET', '/api/v1/me');

      expect(res.status).toBe(200);
      expect(events.callsTo('publish')).toEqual([]);
    });
  });

  describe('/api/v1 reached without the Service host', () => {
    it('answers 401 to a Gateway Key', async () => {
      const { key } = await connectedPod();

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${key}` } });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });

    it('answers 401 to a Caller identity made for another built-in, and to an expired one', async () => {
      const { projectId } = await connectedPod();
      const claims = {
        kind: 'call' as const,
        tenantId: tenant.tenantId,
        projectId,
        projectEnvironmentId: projectId,
        environment: 'development',
      };
      const sealer = app.get(SecretSealer);
      const forEmail = mintCallerIdentity(claims, builtInCallerKey(sealer, 'incoming-email'));
      const expired = mintCallerIdentity(claims, builtInCallerKey(sealer, PUBLIC_API), {
        now: Date.now() - 10 * 60_000,
      });

      for (const identity of [forEmail, expired]) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { [callerIdentityHeader]: identity },
        });
        expect(res.statusCode).toBe(401);
      }
    });
  });
});

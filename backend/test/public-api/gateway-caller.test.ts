import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentSettings, projectGatewayKeys } from '../../db/schema';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectEventsService } from '../../src/project/project-events.service';
import type { FakeProjectEventsService } from '../support/infra-fakes';
import { Perms } from '../../src/permission/permission.constants';
import { MAX_PROJECT_CHAIN_DEPTH } from '../../src/project/project.constants';
import { seedLiveAgent } from '../support/agent-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { ProbeModule } from './support/probe-api';
import {
  addMember,
  clearProjectCreator,
  createTenant,
  createProject,
  platformApiKeyFor,
  removeMemberFromTenant,
  serviceKeyFor,
  setMemberPermissions,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { proxyHeaders } from '../support/proxy-identity';

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('a pod calling the public API with its platform-api gateway key', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let gatewayKeys: GatewayKeyService;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let agentId: string;
  let callerProjectId: string;
  let callerKey: string;

  async function createPlatformApiAgent(): Promise<string> {
    const agent = await seedLiveAgent(tenant.tenantId, creator.userId);
    await db.update(agentSettings).set({ platformApi: true }).where(eq(agentSettings.agentId, agent.id));
    return agent.id;
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp({}, [ProbeModule]);
    app = harness.app;
    gatewayKeys = app.get(GatewayKeyService);

    tenant = await createTenant(app);
    creator = await addMember(app, tenant, [Perms.deleteProject]);
    agentId = await createPlatformApiAgent();

    callerProjectId = await createProject(app, tenant, { agentId, createdBy: creator.userId });
    callerKey = await platformApiKeyFor(app, tenant, callerProjectId);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await setMemberPermissions(tenant, creator, [Perms.deleteProject]);
  });

  describe('resolving the caller', () => {
    it('reports the human who created the calling Project, and says the key did it', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(callerKey) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: creator.userId,
        source: 'gateway-key',
        tenant: { id: tenant.tenantId, name: tenant.name },
      });
    });

    it('does not require can_use_public_api of that human', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(callerKey) });

      expect(res.json().permissions).not.toContain(Perms.usePublicApi);
      expect(res.statusCode).toBe(200);
    });

    it('carries the creator permissions as they stand now, not as they stood at minting', async () => {
      const target = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: callerProjectId,
      });

      await setMemberPermissions(tenant, creator, []);

      const refused = await app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${target}`,
        headers: bearer(callerKey),
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ permission: Perms.deleteProject });

      await setMemberPermissions(tenant, creator, [Perms.deleteProject]);
      const allowed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${target}`,
        headers: bearer(callerKey),
      });
      expect(allowed.statusCode).toBe(204);
    });

    it('re-reads the permissions on every call, not once per key', async () => {
      const first = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(callerKey) });
      expect(first.json().permissions).toContain(Perms.deleteProject);

      await setMemberPermissions(tenant, creator, [Perms.exportProject]);

      const second = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(callerKey) });
      expect(second.json().permissions).toEqual([Perms.exportProject]);
    });

    it('refuses a service gateway key', async () => {
      const serviceKey = await serviceKeyFor(app, tenant, await ordinaryProject());

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(serviceKey) });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });

    it('refuses a key whose Project records no creator', async () => {
      const orphan = await createProject(app, tenant, { agentId, createdBy: creator.userId });
      const key = await platformApiKeyFor(app, tenant, orphan);
      await clearProjectCreator(orphan);

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key) });

      expect(res.statusCode).toBe(401);
    });

    it('refuses a creator who no longer belongs to the key Organization', async () => {
      const leaver = await addMember(app, tenant);
      const theirProject = await createProject(app, tenant, { agentId, createdBy: leaver.userId });
      const key = await platformApiKeyFor(app, tenant, theirProject);

      expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key) })).statusCode).toBe(200);

      await removeMemberFromTenant(leaver);

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:tenant-forbidden' });
    });

    it('refuses a key that carries no Organization, as an unclaimed pool slot does', async () => {
      const unclaimed = await createProject(app, tenant, { agentId, createdBy: creator.userId });
      const key = await platformApiKeyFor(app, tenant, unclaimed);
      await db.update(projectGatewayKeys).set({ tenantId: null }).where(eq(projectGatewayKeys.token, key));

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key) });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('which routes are open', () => {
    it('refuses a route that does not opt in, naming no permission', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/catalogue', headers: bearer(callerKey) });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:permission-denied' });
      expect(res.json()).not.toHaveProperty('permission');
    });

    it('serves all seven opening routes and refuses none of them', async () => {
      const own = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: callerProjectId,
      });

      const answers = await Promise.all([
        app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(callerKey) }),
        app.inject({ method: 'GET', url: '/api/v1/agents', headers: bearer(callerKey) }),
        app.inject({ method: 'GET', url: '/api/v1/projects', headers: bearer(callerKey) }),
        app.inject({ method: 'GET', url: `/api/v1/projects/${own}`, headers: bearer(callerKey) }),
        app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          headers: bearer(callerKey),
          payload: { title: 'Opening set', agentId },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${own}/environments/${own}/connect`,
          headers: bearer(callerKey),
        }),
        app.inject({ method: 'DELETE', url: `/api/v1/projects/${own}`, headers: bearer(callerKey) }),
      ]);

      for (const answer of answers) {
        expect(answer.statusCode, answer.body).not.toBe(403);
      }
      expect(answers.map((answer) => answer.statusCode).slice(0, 5)).toEqual([200, 200, 200, 200, 201]);
    });

    it('ignores x-tenant-name and acts in the Organization its key carries', async () => {
      const elsewhere = await createTenant(app);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { ...bearer(callerKey), 'x-tenant-name': elsewhere.name },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().tenant).toEqual({ id: tenant.tenantId, name: tenant.name });
    });
  });

  describe('which Projects it can reach', () => {
    it('stamps a Project it creates with the creator and the creating Project', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: bearer(callerKey),
        payload: { title: 'Test run', agentId },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ createdBy: creator.userId, createdByProjectId: callerProjectId });
    });

    it('lists only the Projects it created', async () => {
      const own = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: callerProjectId,
      });
      await ordinaryProject();

      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: bearer(callerKey) });

      const ids = res.json().items.map((item: { id: string }) => item.id);
      expect(ids).toContain(own);
      expect(ids).not.toContain(callerProjectId);
    });

    it('answers 404 on read, connect and delete for a Project it did not create', async () => {
      const foreign = await ordinaryProject();

      const read = await app.inject({ method: 'GET', url: `/api/v1/projects/${foreign}`, headers: bearer(callerKey) });
      const connect = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${foreign}/environments/${foreign}/connect`,
        headers: bearer(callerKey),
      });
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${foreign}`,
        headers: bearer(callerKey),
      });

      for (const res of [read, connect, removed]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:project-not-found' });
      }
    });

    it('reads a Project it created', async () => {
      const own = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: callerProjectId,
      });

      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${own}`, headers: bearer(callerKey) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: own, createdByProjectId: callerProjectId });
    });
  });

  describe('how deep the chain may go', () => {
    it('stops minting a platform-api key once a Project would sit at the cap', async () => {
      const root = await createProject(app, tenant, { agentId, createdBy: creator.userId });
      const child = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: root,
      });
      const grandchild = await createProject(app, tenant, {
        agentId,
        createdBy: creator.userId,
        createdByProjectId: child,
      });

      expect(MAX_PROJECT_CHAIN_DEPTH).toBe(2);
      expect(await gatewayKeys.getEnvironmentToken(root, 'platform-api')).not.toBeNull();
      expect(await gatewayKeys.getEnvironmentToken(child, 'platform-api')).not.toBeNull();
      expect(await gatewayKeys.getEnvironmentToken(grandchild, 'platform-api')).toBeNull();
    });

    it('mints no platform-api key for an Agent without the capability', async () => {
      const plain = await ordinaryProject();

      expect(await gatewayKeys.getEnvironmentToken(plain, 'platform-api')).toBeNull();
      expect(await gatewayKeys.getEnvironmentToken(plain)).not.toBeNull();
    });
  });

  describe('waking the page that is watching the calling Project', () => {
    let events: FakeProjectEventsService;

    beforeEach(async () => {
      events = app.get(ProjectEventsService) as unknown as FakeProjectEventsService;
      // The interceptor publishes without awaiting, so let the previous case's call land first.
      await new Promise((resolve) => setImmediate(resolve));
      events.calls.length = 0;
    });

    it('publishes on the calling Project after a write', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: bearer(callerKey),
        payload: { name: 'anything' },
      });

      expect(res.statusCode).toBe(200);
      expect(events.callsTo('publish').map((call) => call.args.projectId)).toEqual([callerProjectId]);
    });

    it('stays quiet on a read', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/paged?limit=1', headers: bearer(callerKey) });

      expect(res.statusCode).toBe(200);
      expect(events.callsTo('publish')).toEqual([]);
    });

    it('stays quiet on a write that failed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: bearer(callerKey),
        payload: { wrong: 'shape' },
      });

      expect(res.statusCode).toBe(400);
      expect(events.callsTo('publish')).toEqual([]);
    });

    it('stays quiet for a human caller, who has no Project to wake', async () => {
      const human = proxyHeaders({
        userId: creator.keycloakId,
        tenants: [tenant.name],
        permissions: [Perms.usePublicApi],
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: human,
        payload: { name: 'anything' },
      });

      expect(res.statusCode).toBe(200);
      expect(events.callsTo('publish')).toEqual([]);
    });
  });

  async function ordinaryProject(): Promise<string> {
    const plain = await seedLiveAgent(tenant.tenantId, creator.userId);
    return createProject(app, tenant, { agentId: plain.id, createdBy: creator.userId });
  }
});

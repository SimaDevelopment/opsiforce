import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';
import { ProjectEventsService } from '../../src/project/project-events.service';
import { CallTokens } from '../../src/gateway/call-tokens';
import { PlatformApiGrant } from '../../src/external-services/gate/platform-api-grant';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
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
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import {
  askGate,
  callOperation,
  callRowsOf,
  configurePlatformService,
  dispatchToFakePod,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type ServicePodFixture,
} from './support/gate';
import { forgetPlatformServiceConfiguration } from './support/fixtures';

const PUBLIC_API = 'public-api';
const platformProbeBuiltInsDir = resolve(__dirname, 'support', 'platform-probe-built-ins');

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('the Public API as a Built-in External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let agentId: string;

  async function pod(createdByProjectId?: string): Promise<{ projectId: string; key: string }> {
    const projectId = await createProject(app, tenant, { agentId, createdBy: creator.userId, createdByProjectId });
    return { projectId, key: await serviceKeyFor(app, tenant, projectId) };
  }

  async function allowCreateProject(projectId: string): Promise<void> {
    await saveProjectConfiguration(app, PUBLIC_API, projectId, { operations: { create_project: true } });
  }

  function createProjectThroughGate(key: string, title: string) {
    return callOperation(app, { key, slug: PUBLIC_API, operation: 'create_project', input: { title, agentId } });
  }

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    app = harness.app;
    await harness.listen();
    tenant = await createTenant(app);
    creator = await addMember(app, tenant, [Perms.deleteProject]);
    agentId = (await seedLiveAgent(tenant.tenantId, creator.userId)).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is Available with an empty Service form, reads on and writes off', async () => {
    const { key } = await pod();

    const res = await askGate(app, { key, path: PUBLIC_API });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      service: PUBLIC_API,
      displayName: 'Opsiforce Public API',
      complete: true,
      operations: {
        get_me: { kind: 'read', on: true },
        validate_skill: { kind: 'read', on: true },
        create_project: { kind: 'write', on: false },
        remove_agent_skill: { kind: 'write', on: false },
        delete_project: { kind: 'destructive', on: false },
        reset_test_project: { kind: 'destructive', on: false },
      },
    });
  });

  it('answers get_me as the human who created the calling Project, through a call token', async () => {
    const { projectId, key } = await pod();

    const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_me' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: creator.userId,
      source: 'call-token',
      tenant: { id: tenant.tenantId, name: tenant.name },
    });
    const [row] = await callRowsOf(projectId);
    expect(row).toMatchObject({ operation: 'get_me', decision: 'allowed', status: 200 });
  });

  it('creates a Project stamped with the creator and the calling Project once create_project is on', async () => {
    const { projectId, key } = await pod();

    const refused = await createProjectThroughGate(key, 'Switched off');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'operation-off', operation: 'create_project' });

    await allowCreateProject(projectId);
    const res = await createProjectThroughGate(key, 'Through the Gate');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Through the Gate',
      createdBy: creator.userId,
      createdByProjectId: projectId,
    });
  });

  it('passes the Public API refusal through: a Project the caller did not create is not found', async () => {
    const { projectId: foreign } = await pod();
    const { key } = await pod();

    const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_project', input: { id: foreign } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'project-not-found' });
  });

  describe('who the call acts as', () => {
    it('does not require can_use_public_api of the creator', async () => {
      const { key } = await pod();

      const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_me' });

      expect(res.json().permissions).not.toContain(Perms.usePublicApi);
    });

    it("carries the creator's permissions as they stand at each call", async () => {
      const { projectId, key } = await pod();
      await saveProjectConfiguration(app, PUBLIC_API, projectId, { operations: { delete_project: true } });
      const target = (await pod(projectId)).projectId;
      const deleteTarget = () =>
        callOperation(app, { key, slug: PUBLIC_API, operation: 'delete_project', input: { id: target } });

      await setMemberPermissions(tenant, creator, []);
      const refused = await deleteTarget();
      await setMemberPermissions(tenant, creator, [Perms.deleteProject]);
      const allowed = await deleteTarget();

      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toMatchObject({ code: 'permission-denied', permission: Perms.deleteProject });
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it('refuses a Project that records no creator', async () => {
      const { projectId, key } = await pod();
      await clearProjectCreator(projectId);

      const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_me' });

      expect(res.json()).toMatchObject({ code: 'unauthenticated' });
    });

    it('refuses a creator who no longer belongs to the Organization', async () => {
      const leaver = await addMember(app, tenant);
      const projectId = await createProject(app, tenant, { agentId, createdBy: leaver.userId });
      const key = await serviceKeyFor(app, tenant, projectId);
      await removeMemberFromTenant(leaver);

      const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_me' });

      expect(res.json()).toMatchObject({ code: 'tenant-forbidden' });
    });

    it('lists only the Projects its Project created', async () => {
      const { projectId, key } = await pod();
      const own = (await pod(projectId)).projectId;
      const { projectId: foreign } = await pod();

      const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'list_projects' });

      const ids = res.json().items.map((item: { id: string }) => item.id);
      expect(ids).toContain(own);
      expect(ids).not.toContain(foreign);
      expect(ids).not.toContain(projectId);
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
      const { projectId, key } = await pod();
      await allowCreateProject(projectId);

      const res = await createProjectThroughGate(key, 'Wakes the page');

      expect(res.statusCode, res.body).toBe(200);
      expect(events.callsTo('publish').map((call) => call.args.projectId)).toContain(projectId);
    });

    it('stays quiet on a read', async () => {
      const { key } = await pod();
      await new Promise((resolve) => setImmediate(resolve));
      events.calls.length = 0;

      const res = await callOperation(app, { key, slug: PUBLIC_API, operation: 'get_me' });

      expect(res.statusCode).toBe(200);
      expect(events.callsTo('publish')).toEqual([]);
    });
  });

  describe('how deep the chain may go', () => {
    it('lets a Project at depth 1 create a Project', async () => {
      const root = await pod();
      const child = await pod(root.projectId);
      await allowCreateProject(child.projectId);

      const res = await createProjectThroughGate(child.key, 'Grandchild');

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ createdByProjectId: child.projectId });
    });

    it('refuses create_project from a Project at depth 2 with 409 chain-too-deep', async () => {
      const root = await pod();
      const child = await pod(root.projectId);
      const grandchild = await pod(child.projectId);
      await allowCreateProject(grandchild.projectId);

      const res = await createProjectThroughGate(grandchild.key, 'Too deep');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'chain-too-deep' });
    });
  });

  describe('/api/v1 and pod credentials', () => {
    it('answers 401 to a Gateway Key', async () => {
      const { key } = await pod();

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(key) });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });

    it('answers 401 to a call token no Gate call issued', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer('gc-made-up') });

      expect(res.statusCode).toBe(401);
    });
  });
});

describe('the call token a Built-in External Service gets', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let tenant: TenantFixture;
  let projectId: string;
  let key: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: platformProbeBuiltInsDir });
    app = harness.app;
    await harness.listen();
    tenant = await createTenant(app);
    const creator = await addMember(app, tenant);
    projectId = await createProject(app, tenant, { createdBy: creator.userId });
    key = await serviceKeyFor(app, tenant, projectId);
  });

  afterAll(async () => {
    await harness.close();
  });

  function probe(kind: string) {
    return callOperation(app, { key, slug: 'public-api', operation: 'get_me', input: { probe: kind } });
  }

  it('is handed only to public-api, never to another Built-in External Service', async () => {
    const otherBuiltIn = await callOperation(app, {
      key,
      slug: 'platform-probe',
      operation: 'get_me',
      input: { probe: 'keep' },
    });
    const publicApi = await probe('keep');

    expect(otherBuiltIn.statusCode, otherBuiltIn.body).toBe(200);
    expect(otherBuiltIn.json()).toEqual({ kept: false });
    expect(publicApi.json()).toEqual({ kept: true });
  });

  it('is minted only for the built-in public-api, never for a service of another origin under that slug', () => {
    const publicApi = app.get(ServiceRegistry).bySlug('public-api');
    if (!publicApi) throw new Error('public-api is not registered');
    const grant = app.get(PlatformApiGrant);
    const call = {
      callId: randomUUID(),
      operation: 'get_me',
      caller: {
        tenantId: tenant.tenantId,
        projectId,
        projectTitle: null,
        projectKind: null,
        projectEnvironmentId: randomUUID(),
        environment: 'production',
        environmentName: 'Production',
      },
    };

    const granted = grant.grantFor(publicApi, call);
    expect(granted).not.toBeNull();
    granted?.revoke();
    expect(grant.grantFor({ ...publicApi, origin: 'custom' }, call)).toBeNull();
  });

  it('is refused by the Public API when it was minted for another service', async () => {
    const tokens = app.get(CallTokens);
    const holder = {
      callId: randomUUID(),
      operation: 'get_me',
      tenantId: tenant.tenantId,
      projectId,
      projectEnvironmentId: randomUUID(),
    };
    const forAnotherService = tokens.issue({ ...holder, service: 'platform-probe' });
    const forPublicApi = tokens.issue({ ...holder, service: 'public-api' });

    const refused = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(forAnotherService.token) });
    const accepted = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(forPublicApi.token) });

    expect(refused.statusCode).toBe(401);
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('works once: the second use within the same call is refused', async () => {
    const res = await probe('me-twice');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ first: 200, second: 401 });
  });

  it('works only during its own call: a token kept from an earlier call is refused', async () => {
    const kept = await probe('keep');
    expect(kept.json()).toEqual({ kept: true });

    const res = await probe('me-with-kept');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 401 });
  });

  it('works only for the Operation it was minted for: another Public API route refuses it', async () => {
    const res = await probe('another-route');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 401 });
  });
});

describe('a service running in its own pod', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let service: ServicePodFixture | undefined;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    await harness.listen();
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('gets no call token', async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    const [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM));
    const caller = await gateCaller(app);
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox,
      accountIds: ['acc_1'],
    });
    service = await dispatchToFakePod(app, FIXTURE_SERVICE);

    const res = await callOperation(app, {
      key: caller.key,
      slug: FIXTURE_SERVICE,
      operation: 'get_account',
      input: { accountId: 'acc_1' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(service.pod.received).toHaveLength(1);
    expect(service.pod.received[0]?.platformApi).toBeUndefined();
  });
});

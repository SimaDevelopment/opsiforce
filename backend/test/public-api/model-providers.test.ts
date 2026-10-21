import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { modelProviders, projectEnvironments, projects } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersService } from '../../src/model-provider/model-provider.service';
import { PodService } from '../../src/pod/pod.service';
import { ProjectPoolService } from '../../src/pool/project-pool.service';
import { ProjectStatus } from '../../src/project/project.types';
import type { FakePodService } from '../support/infra-fakes';
import { waitFor } from '../support/wait-for';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { addMember, createAgent, createTenant, type MemberFixture } from '../support/project-fixtures';

const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];

describe('chat keys follow the Organization’s Model provider rows', () => {
  let bifrost: FakeBifrost;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    harness = await createPublicApiTestApp(bifrost.env, [], [BifrostService]);
    app = harness.app;
    agentId = await createAgent();
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
  });

  async function createProject(member: MemberFixture): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: member.headers,
      payload: { title: 'Routed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function setRow(
    tenantId: string,
    bifrostProvider: string,
    change: { chatEnabled?: boolean; chatWeight?: number; backendEnabled?: boolean; backendWeight?: number }
  ) {
    const [current] = await db
      .select({
        chatEnabled: modelProviders.chatEnabled,
        chatWeight: modelProviders.chatWeight,
        backendEnabled: modelProviders.backendEnabled,
        backendWeight: modelProviders.backendWeight,
      })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.bifrostProvider, bifrostProvider),
          or(eq(modelProviders.tenantId, tenantId), isNull(modelProviders.tenantId))
        )
      )
      .orderBy(sql`${modelProviders.tenantId} nulls last`);
    if (!current) throw new Error(`${bifrostProvider} is neither the Organization's nor the platform's`);
    const row = { ...current, ...change };
    await db
      .insert(modelProviders)
      .values({ tenantId, bifrostProvider, ...row })
      .onConflictDoUpdate({
        target: [
          modelProviders.tenantId,
          modelProviders.bifrostProvider,
          modelProviders.bifrostKey,
          modelProviders.baseFormat,
        ],
        set: row,
      });
  }

  it('gives a new Organization’s first chat key the platform’s enabled providers at their platform weights', async () => {
    const tenant = await createTenant(app);
    const projectId = await createProject(await addMember(app, tenant));

    expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
      { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
      { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
      { provider: 'openai', weight: 0, ...CATALOG_WIDE },
    ]);
  });

  it('writes only enabled rows that exist in Bifrost, weights as they are, and routes the backend key by the App switches', async () => {
    const tenant = await createTenant(app);
    const member = await addMember(app, tenant);
    await setRow(tenant.tenantId, 'anthropic', { chatWeight: 7, backendWeight: 2 });
    await setRow(tenant.tenantId, 'openai', { chatEnabled: false });
    bifrost.setProviders(['openai', 'anthropic']);
    try {
      const projectId = await createProject(member);

      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'anthropic', weight: 7, ...CATALOG_WIDE },
      ]);
      expect(bifrost.backendKeyOf(projectId).provider_configs).toEqual([
        { provider: 'anthropic', weight: 2, ...CATALOG_WIDE },
        { provider: 'openai', weight: 1, ...CATALOG_WIDE },
      ]);
    } finally {
      bifrost.setProviders(HELM_PROVIDERS);
    }
  });

  it('rewrites every chat and backend key of the Organization and no other Organization’s keys', async () => {
    const tenant = await createTenant(app);
    const member = await addMember(app, tenant);
    const first = await createProject(member);
    const second = await createProject(member);
    const neighbour = await createProject(await addMember(app, await createTenant(app)));
    const neighbourConfigs = bifrost.chatKeyOf(neighbour).provider_configs;
    const neighbourWrites = bifrost.providerConfigWritesTo(bifrost.chatKeyOf(neighbour).id).length;

    await setRow(tenant.tenantId, 'openai', { chatWeight: 5 });
    await setRow(tenant.tenantId, 'anthropic', { chatEnabled: false });
    await app.get(ModelProvidersService).lockAndRewriteTenantKeys(tenant.tenantId);

    const expected = [
      { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
      { provider: 'openai', weight: 5, ...CATALOG_WIDE },
    ];
    expect(bifrost.chatKeyOf(first).provider_configs).toEqual(expected);
    expect(bifrost.chatKeyOf(second).provider_configs).toEqual(expected);
    expect(bifrost.chatKeyOf(neighbour).provider_configs).toEqual(neighbourConfigs);
    expect(bifrost.providerConfigWritesTo(bifrost.chatKeyOf(neighbour).id)).toHaveLength(neighbourWrites);
    expect(bifrost.backendKeyOf(first).provider_configs).toEqual([
      { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
      { provider: 'openai', weight: 1, ...CATALOG_WIDE },
    ]);
  });

  it('fails the Project create when its chat key cannot take the Organization’s providers', async () => {
    const member = await addMember(app, await createTenant(app));
    bifrost.refuseProviderConfigWrites();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: member.headers,
        payload: { title: 'Unrouted', agentId },
      });

      expect(res.statusCode).toBe(500);
      const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: member.headers });
      expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    } finally {
      bifrost.acceptProviderConfigWrites();
    }
  });
});

async function suspendEarlierPoolRows(agentId: string): Promise<void> {
  const earlier = db.select({ id: projects.id }).from(projects).where(eq(projects.agentId, agentId));
  await db
    .update(projectEnvironments)
    .set({ status: ProjectStatus.Suspended })
    .where(
      and(
        inArray(projectEnvironments.projectId, earlier),
        inArray(projectEnvironments.status, [ProjectStatus.Pending, ProjectStatus.Claiming])
      )
    );
}

describe('a pooled Project takes the Organization’s Model providers when it is claimed', () => {
  let bifrost: FakeBifrost;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let pool: ProjectPoolService;
  let pods: FakePodService;
  let agentId: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    agentId = await createAgent();
    await suspendEarlierPoolRows(agentId);
    harness = await createPublicApiTestApp(
      { ...bifrost.env, POOL_SIZE_OVERRIDE: '1' },
      [],
      [BifrostService, ProjectPoolService]
    );
    app = harness.app;
    pool = app.get(ProjectPoolService);
    pods = app.get<FakePodService>(PodService);
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
  });

  async function pendingSlotIds(): Promise<string[]> {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(and(isNull(projects.tenantId), eq(projectEnvironments.status, ProjectStatus.Pending)));
    return rows.map((row) => row.id);
  }

  async function newPendingSlot(known: Set<string>): Promise<string | undefined> {
    const slotId = (await pendingSlotIds()).find((id) => !known.has(id));
    const podName = slotId && pods.assignedPodName(slotId);
    return pods.callsTo('waitForReady').some((call) => call.args.podName === podName) ? slotId : undefined;
  }

  async function provisionPoolSlot(): Promise<string> {
    const known = new Set(await pendingSlotIds());
    const replenished = pool.runReplenishJob(agentId);
    let slotId: string | undefined;
    await waitFor(async () => {
      slotId = await newPendingSlot(known);
      return slotId !== undefined;
    });
    if (!slotId) throw new Error('The pool created no slot');
    pods.markPodReady(pods.assignedPodName(slotId), '127.0.0.1');
    await replenished;
    return slotId;
  }

  async function createProject(member: MemberFixture): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: member.headers,
      payload: { title: 'Claimed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('writes the claiming Organization’s rows to the slot’s chat key', async () => {
    const slotId = await provisionPoolSlot();
    expect(bifrost.chatKeyOf(slotId).provider_configs).toEqual([]);
    expect(bifrost.backendKeyOf(slotId).provider_configs).toEqual([]);
    const tenant = await createTenant(app);
    await db.insert(modelProviders).values({
      tenantId: tenant.tenantId,
      bifrostProvider: 'anthropic',
      chatEnabled: true,
      chatWeight: 3,
      backendEnabled: false,
      backendWeight: 1,
    });

    const projectId = await createProject(await addMember(app, tenant));

    expect(projectId).toBe(slotId);
    expect(bifrost.chatKeyOf(slotId).provider_configs).toEqual([
      { provider: 'anthropic', weight: 3, ...CATALOG_WIDE },
      { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
      { provider: 'openai', weight: 0, ...CATALOG_WIDE },
    ]);
    expect(bifrost.backendKeyOf(slotId).provider_configs).toEqual([{ provider: 'openai', weight: 1, ...CATALOG_WIDE }]);
  });

  it('creates the Project the slow way when the slot’s chat key keeps refusing the rows', async () => {
    const slotId = await provisionPoolSlot();
    bifrost.refuseProviderConfigWrites(bifrost.chatKeyOf(slotId).id);

    const projectId = await createProject(await addMember(app, await createTenant(app)));

    expect(projectId).not.toBe(slotId);
    expect(await pendingSlotIds()).toContain(slotId);
    expect(bifrost.providerConfigWritesTo(bifrost.chatKeyOf(slotId).id)).toHaveLength(3);
    expect(bifrost.chatKeyOf(projectId).provider_configs).toHaveLength(3);
  });
});

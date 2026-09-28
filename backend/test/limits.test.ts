import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { projectSettings } from '../db/schema';
import { DefaultsService } from '../src/defaults/defaults.service';
import { LimitReachedException } from '../src/limit/limit-reached.exception';
import { LimitService } from '../src/limit/limit.service';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';

let harness: DomainTestHarness;
const limits = new LimitService();

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

async function newTenant(projectLimit?: number | null): Promise<string> {
  const tenant = await harness.tenants.getOrCreateTenant(`limit-${randomUUID()}`);
  if (projectLimit !== undefined) await limits.setTenantLimit(tenant.id, 'projects', projectLimit);
  return tenant.id;
}

async function createProjects(tenantId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push((await harness.projects.create({ title: `Project ${i}` }, tenantId)).id);
  }
  return ids;
}

async function projectUsage(tenantId: string) {
  return (await limits.usage(tenantId)).find((usage) => usage.key === 'projects');
}

async function withPlatformProjectLimit(value: number | null, run: () => Promise<void>): Promise<void> {
  const previous = (await limits.platformView()).platform.find((limit) => limit.key === 'projects')?.value ?? null;
  try {
    await limits.setPlatformLimit('projects', value);
    await run();
  } finally {
    await limits.setPlatformLimit('projects', previous);
  }
}

function defaultAgent(tenantId: string): Promise<string> {
  return harness.agents.getDefaultAgentId(tenantId);
}

function importParams(tenantId: string, agentId: string) {
  return {
    tenantId,
    workspaceId: null,
    folderId: null,
    title: 'Imported',
    timezone: 'UTC',
    agentId,
    importedAgent: null,
    description: null,
    settings: null,
    resources: null,
    appDetails: null,
    schedules: [],
    createdBy: null,
  };
}

async function appTimeoutIdleOf(projectId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ appTimeoutIdle: projectSettings.appTimeoutIdle })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId));
  return row?.appTimeoutIdle;
}

describe('platform and organization limits', () => {
  it('lets an organization without its own limit follow the platform value, including later changes', async () => {
    await withPlatformProjectLimit(2, async () => {
      const tenantId = await newTenant();
      expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 2, used: 0 });

      await limits.setPlatformLimit('projects', 3);
      expect((await projectUsage(tenantId))?.limit).toBe(3);
    });
  });

  it('keeps an overridden organization on its own value and returns it to the platform value on follow', async () => {
    await withPlatformProjectLimit(2, async () => {
      const tenantId = await newTenant(null);
      expect((await projectUsage(tenantId))?.limit).toBeNull();

      await limits.followPlatformLimit(tenantId, 'projects');
      expect((await projectUsage(tenantId))?.limit).toBe(2);
    });
  });

  it('marks which organizations override a limit in the platform view', async () => {
    const overridden = await newTenant(4);
    const following = await newTenant();

    const { tenants } = await limits.platformView();
    const limitOf = (tenantId: string) => tenants.find((tenant) => tenant.tenantId === tenantId)?.limits[0];

    expect(limitOf(overridden)).toMatchObject({ key: 'projects', limit: 4, overridden: true });
    expect(limitOf(following)).toMatchObject({ key: 'projects', overridden: false });
  });

  it('refuses an unknown limit and a value that is not a non-negative integer', async () => {
    const tenantId = await newTenant();

    await expect(limits.setTenantLimit(tenantId, 'workspaces', 1)).rejects.toThrow('Unknown limit');
    await expect(limits.setTenantLimit(tenantId, 'projects', -1)).rejects.toThrow();
    await expect(limits.setTenantLimit(tenantId, 'projects', 1.5)).rejects.toThrow();
    await expect(limits.setPlatformLimit('projects', '5')).rejects.toThrow();
  });

  it('refuses an override for an organization that does not exist', async () => {
    await expect(limits.setTenantLimit(randomUUID(), 'projects', 1)).rejects.toThrow('not found');
  });
});

describe('project limit', () => {
  it('refuses the project past the limit and reports usage', async () => {
    const tenantId = await newTenant(2);
    await createProjects(tenantId, 2);

    await expect(harness.projects.create({ title: 'One too many' }, tenantId)).rejects.toBeInstanceOf(
      LimitReachedException
    );
    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 2, used: 2 });
  });

  it('leaves an organization overridden to no limit unbounded', async () => {
    const tenantId = await newTenant(null);
    await createProjects(tenantId, 6);

    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: null, used: 6 });
  });

  it('does not count builder chats or test projects', async () => {
    const tenantId = await newTenant(1);
    await createProjects(tenantId, 1);

    await harness.projects.create({ title: 'Chat' }, tenantId, { kind: 'agent_builder_chat' });
    await harness.projects.create({ title: 'Test' }, tenantId, { kind: 'test' });

    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 1, used: 1 });
  });

  it('frees a slot when a project is disabled and refuses re-enabling it once the slot is taken', async () => {
    const tenantId = await newTenant(2);
    const [first] = await createProjects(tenantId, 2);
    await harness.projects.disable(first, tenantId);
    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 2, used: 1 });

    await harness.projects.create({}, tenantId);

    await expect(harness.projects.enable(first, tenantId)).rejects.toBeInstanceOf(LimitReachedException);
    expect((await harness.projects.findOne(first, tenantId)).disabled).toBe(true);
  });

  it('re-enables a disabled project while there is room', async () => {
    const tenantId = await newTenant(2);
    const [first] = await createProjects(tenantId, 2);
    await harness.projects.disable(first, tenantId);

    await expect(harness.projects.enable(first, tenantId)).resolves.toMatchObject({ disabled: false });
  });

  it('gives the slot back when provisioning fails after the row is written', async () => {
    const tenantId = await newTenant(2);
    const [source] = await createProjects(tenantId, 1);
    const provisioning = vi.spyOn(harness.fakes.externalServices, 'provisionEnvironment');

    provisioning.mockRejectedValueOnce(new Error('provisioning down'));
    await expect(harness.projects.create({}, tenantId)).rejects.toThrow('provisioning down');
    provisioning.mockRejectedValueOnce(new Error('provisioning down'));
    await expect(harness.projects.duplicate(source, tenantId, undefined, null)).rejects.toThrow('provisioning down');
    provisioning.mockRejectedValueOnce(new Error('provisioning down'));
    await expect(
      harness.projects.createImportedProject(importParams(tenantId, await defaultAgent(tenantId)))
    ).rejects.toThrow('provisioning down');

    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 2, used: 1 });
    provisioning.mockRestore();
  });

  it('frees a slot when a project is deleted', async () => {
    const tenantId = await newTenant(1);
    const [only] = await createProjects(tenantId, 1);

    await harness.projects.remove(only, tenantId);
    await expect(harness.projects.create({}, tenantId)).resolves.toBeDefined();
  });

  it('refuses a duplicate at the limit', async () => {
    const tenantId = await newTenant(1);
    const [source] = await createProjects(tenantId, 1);

    await expect(harness.projects.duplicate(source, tenantId, undefined, null)).rejects.toBeInstanceOf(
      LimitReachedException
    );
  });

  it('refuses an import at the limit', async () => {
    const tenantId = await newTenant(1);
    await createProjects(tenantId, 1);

    await expect(
      harness.projects.createImportedProject(importParams(tenantId, await defaultAgent(tenantId)))
    ).rejects.toBeInstanceOf(LimitReachedException);
  });

  it('keeps existing projects when the limit is lowered below the count', async () => {
    const tenantId = await newTenant(null);
    await createProjects(tenantId, 3);
    await limits.setTenantLimit(tenantId, 'projects', 1);

    await expect(harness.projects.create({}, tenantId)).rejects.toBeInstanceOf(LimitReachedException);
    expect(await projectUsage(tenantId)).toEqual({ key: 'projects', limit: 1, used: 3 });
  });

  it('lets exactly one of several concurrent creates take the last slot', async () => {
    const tenantId = await newTenant(3);
    await createProjects(tenantId, 2);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => harness.projects.create({ title: `Race ${i}` }, tenantId))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect(rejected.reason).toBeInstanceOf(LimitReachedException);
    }
  });
});

describe('test project idle timeouts', () => {
  it('suspends a test project app on the agent idle timeout instead of the app one', async () => {
    const tenantId = await newTenant();
    const timeouts = await harness.moduleRef.get(DefaultsService).getTenantTimeouts(tenantId);

    const testProject = await harness.projects.create({ title: 'Test' }, tenantId, { kind: 'test' });
    const ordinary = await harness.projects.create({ title: 'Ordinary' }, tenantId);

    expect(await appTimeoutIdleOf(testProject.id)).toBe(timeouts.defaultTimeoutIdle);
    expect(await appTimeoutIdleOf(ordinary.id)).toBe(timeouts.defaultAppTimeoutIdle);
  });
});

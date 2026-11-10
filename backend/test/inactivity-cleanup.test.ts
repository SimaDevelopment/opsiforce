import { eq, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { agentInactivityCleanup, projectEnvironments, projects } from '../db/schema';
import { DefaultsService } from '../src/defaults/defaults.service';
import { InactivityCleanupProcessor } from '../src/project/inactivity-cleanup.processor';
import type { ProjectService } from '../src/project/project.service';
import { AgentStatusService } from '../src/project/agent-status.service';
import { writeAgentInactivityCleanup, type InactivityCleanup } from '../src/project/inactivity-cleanup';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { createUserRow } from './support/org-fixtures';

let harness: DomainTestHarness;

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function tenantWithCleanup(disableAfterDays: number | null, deleteAfterDays: number | null) {
  const disableAfter = disableAfterDays === null ? null : disableAfterDays * DAY_MS;
  const deleteAfter = deleteAfterDays === null ? null : deleteAfterDays * DAY_MS;
  const tenant = await harness.tenants.getOrCreateTenant(`inactivity-${crypto.randomUUID()}`);
  await harness.moduleRef.get(DefaultsService).updateTenantTimeouts(tenant.id, {
    defaultDisableAfter: disableAfter,
    defaultDeleteAfter: deleteAfter,
  });
  return tenant;
}

async function lastActive(projectId: string, daysAgo: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  await db.update(projects).set({ createdAt: at }).where(eq(projects.id, projectId));
  await db.update(projectEnvironments).set({ lastActiveAt: at }).where(eq(projectEnvironments.projectId, projectId));
}

function sweep(): Promise<void> {
  return new InactivityCleanupProcessor(harness.projects).process();
}

async function stateOf(projectId: string): Promise<'enabled' | 'disabled' | 'deleted'> {
  const [row] = await db.select({ disabled: projects.disabled }).from(projects).where(eq(projects.id, projectId));
  if (!row) return 'deleted';
  return row.disabled ? 'disabled' : 'enabled';
}

async function withPlatformCleanup(
  agentId: string,
  cleanup: InactivityCleanup | null,
  run: () => Promise<void>
): Promise<void> {
  const [before] = await db
    .select({
      disableAfter: agentInactivityCleanup.disableAfter,
      deleteAfter: agentInactivityCleanup.deleteAfter,
    })
    .from(agentInactivityCleanup)
    .where(eq(agentInactivityCleanup.agentId, agentId));
  await writeAgentInactivityCleanup(agentId, cleanup);
  try {
    await run();
  } finally {
    await writeAgentInactivityCleanup(agentId, before ?? null);
  }
}

async function builtInAgentIn(tenantId: string) {
  const agentId = await harness.agents.getDefaultAgentId(tenantId);
  const caller = { tenantId, userId: await createUserRow(), canManageAgents: true };
  return { agentId, caller };
}

describe('a new Project', () => {
  it("takes its Built-in Agent's platform pair whole, an empty count meaning never", async () => {
    const tenant = await tenantWithCleanup(30, 60);
    const { agentId } = await builtInAgentIn(tenant.id);

    await withPlatformCleanup(agentId, { disableAfter: 90 * DAY_MS, deleteAfter: null }, async () => {
      const project = await harness.projects.create({ title: 'Platform pair' }, tenant.id);

      expect(project).toMatchObject({ disableAfter: 90 * DAY_MS, deleteAfter: null });
    });
  });

  it('takes the tenant default pair when no layer above sets one, and the Agent names it as inherited', async () => {
    const tenant = await tenantWithCleanup(30, 60);
    const { agentId, caller } = await builtInAgentIn(tenant.id);

    await withPlatformCleanup(agentId, null, async () => {
      const project = await harness.projects.create({ title: 'Tenant pair' }, tenant.id);
      const agent = await harness.agents.findOne(caller, agentId);

      expect({ project, cleanup: agent.inactivityCleanup }).toMatchObject({
        project: { disableAfter: 30 * DAY_MS, deleteAfter: 60 * DAY_MS },
        cleanup: {
          cleanup: { disableAfter: 30 * DAY_MS, deleteAfter: 60 * DAY_MS },
          source: 'default',
          inherited: { disableAfter: 30 * DAY_MS, deleteAfter: 60 * DAY_MS },
          platformChoice: null,
        },
      });
    });
  });

  it("takes a tenant's own pair for a Built-in Agent over the platform's, both empty meaning never, until it is reset", async () => {
    const tenant = await tenantWithCleanup(30, 60);
    const { agentId, caller } = await builtInAgentIn(tenant.id);

    await withPlatformCleanup(agentId, { disableAfter: 90 * DAY_MS, deleteAfter: null }, async () => {
      await harness.agents.updateInactivityCleanup(caller, agentId, { disableAfter: null, deleteAfter: null });
      const own = await harness.projects.create({ title: 'Own pair' }, tenant.id);
      await harness.agents.resetInactivityCleanup(caller, agentId);
      const reset = await harness.projects.create({ title: 'Reset' }, tenant.id);

      expect({ own, reset }).toMatchObject({
        own: { disableAfter: null, deleteAfter: null },
        reset: { disableAfter: 90 * DAY_MS, deleteAfter: null },
      });
    });
  });

  it('keeps its own days when the tenant default changes later', async () => {
    const tenant = await tenantWithCleanup(null, null);
    const project = await harness.projects.create({ title: 'Kept' }, tenant.id);

    await harness.moduleRef.get(DefaultsService).updateTenantTimeouts(tenant.id, { defaultDisableAfter: 1 * DAY_MS });

    expect(await harness.projects.findOne(project.id, tenant.id)).toMatchObject({
      disableAfter: null,
      deleteAfter: null,
    });
  });
});

describe('the Inactivity cleanup sweep', () => {
  it('disables a Project idle past Disable after, deletes one idle past Delete after and leaves an active one', async () => {
    const tenant = await tenantWithCleanup(14, 28);
    const idle = await harness.projects.create({ title: 'Idle' }, tenant.id);
    const abandoned = await harness.projects.create({ title: 'Abandoned' }, tenant.id);
    const active = await harness.projects.create({ title: 'Active' }, tenant.id);
    await lastActive(idle.id, 20);
    await lastActive(abandoned.id, 30);
    await lastActive(active.id, 1);

    await sweep();

    expect({
      idle: await stateOf(idle.id),
      abandoned: await stateOf(abandoned.id),
      active: await stateOf(active.id),
    }).toEqual({ idle: 'disabled', abandoned: 'deleted', active: 'enabled' });
  });

  it('acts on an hours count as well as a days count', async () => {
    const tenant = await tenantWithCleanup(null, null);
    const project = await harness.projects.create({ title: 'Hours' }, tenant.id);
    await harness.projects.update(project.id, { disableAfter: 6 * HOUR_MS }, tenant.id);
    await lastActive(project.id, 7 / 24);

    await sweep();

    expect(await stateOf(project.id)).toBe('disabled');
  });

  it('counts App traffic on any environment as activity', async () => {
    const tenant = await tenantWithCleanup(14, null);
    const project = await harness.projects.create({ title: 'App in use' }, tenant.id);
    await lastActive(project.id, 20);
    await harness.projects.touchEnvironmentActivity(project.id, 'app');

    await sweep();

    expect(await stateOf(project.id)).toBe('enabled');
  });

  it('starts the clock again when a disabled Project is enabled', async () => {
    const tenant = await tenantWithCleanup(14, null);
    const project = await harness.projects.create({ title: 'Brought back' }, tenant.id);
    await lastActive(project.id, 20);
    await sweep();

    await harness.projects.enable(project.id, tenant.id);
    await sweep();

    expect(await stateOf(project.id)).toBe('enabled');
  });

  it('checks each Project again right before acting, so one used while the sweep runs survives', async () => {
    const tenant = await tenantWithCleanup(null, 28);
    const first = await harness.projects.create({ title: 'First' }, tenant.id);
    const second = await harness.projects.create({ title: 'Second' }, tenant.id);
    await lastActive(first.id, 30);
    await lastActive(second.id, 30);
    let usedMeanwhile: string | null = null;
    const usedMidSweep: ProjectService = Object.assign(Object.create(harness.projects), {
      async removeIfStill(id: string, tenantId: string, condition: SQL) {
        usedMeanwhile ??= id === first.id ? second.id : first.id;
        if (usedMeanwhile !== id) await harness.projects.touchEnvironmentActivity(usedMeanwhile, 'app');
        return harness.projects.removeIfStill(id, tenantId, condition);
      },
    });

    await new InactivityCleanupProcessor(usedMidSweep).process();

    expect([await stateOf(first.id), await stateOf(second.id)].toSorted()).toEqual(['deleted', 'enabled']);
  });

  it('leaves a Project whose Delete after is cleared after the sweep picked it', async () => {
    const tenant = await tenantWithCleanup(null, 28);
    const project = await harness.projects.create({ title: 'Reprieved' }, tenant.id);
    await lastActive(project.id, 30);
    const clearedMidSweep: ProjectService = Object.assign(Object.create(harness.projects), {
      async removeIfStill(id: string, tenantId: string, condition: SQL) {
        await harness.projects.update(id, { deleteAfter: null }, tenantId);
        return harness.projects.removeIfStill(id, tenantId, condition);
      },
    });

    await new InactivityCleanupProcessor(clearedMidSweep).process();

    expect(await stateOf(project.id)).toBe('enabled');
  });

  it('counts a Working Agent as activity, so an unattended run longer than Delete after survives', async () => {
    const tenant = await tenantWithCleanup(null, 1);
    const project = await harness.projects.create({ title: 'Long run' }, tenant.id);
    await lastActive(project.id, 2);
    const [env] = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, project.id));
    const agentStatus = harness.moduleRef.get(AgentStatusService);

    agentStatus.runStarted(project.id, env.id, 'unattended-run');
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ lastActiveAt: projectEnvironments.lastActiveAt })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.id, env.id));
      expect(row.lastActiveAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
    await sweep();
    agentStatus.runEnded(project.id, env.id, 'unattended-run');

    expect(await stateOf(project.id)).toBe('enabled');
  });

  it('never touches a Project without days of its own', async () => {
    const tenant = await tenantWithCleanup(null, null);
    const project = await harness.projects.create({ title: 'Forever' }, tenant.id);
    await lastActive(project.id, 400);

    await sweep();

    expect(await stateOf(project.id)).toBe('enabled');
  });
});

describe("a Built-in Agent's platform pair", () => {
  it('is set and reset through the platform defaults, and refused for a Custom Agent', async () => {
    const defaults = harness.moduleRef.get(DefaultsService);
    const tenant = await tenantWithCleanup(30, 60);
    const { agentId, caller } = await builtInAgentIn(tenant.id);
    const custom = await harness.agents.create(caller, { displayName: `Custom ${crypto.randomUUID().slice(0, 8)}` });

    await withPlatformCleanup(agentId, null, async () => {
      await defaults.updateBuiltInAgentInactivityCleanup(agentId, { disableAfter: 45 * DAY_MS });
      const set = (await harness.agents.findOne(caller, agentId)).inactivityCleanup;
      await defaults.resetBuiltInAgentInactivityCleanup(agentId);
      const reset = (await harness.agents.findOne(caller, agentId)).inactivityCleanup;

      expect({ set, reset }).toMatchObject({
        set: {
          source: 'platform',
          cleanup: { disableAfter: 45 * DAY_MS },
          platformChoice: { disableAfter: 45 * DAY_MS },
        },
        reset: { source: 'default', platformChoice: null },
      });
    });
    await expect(
      defaults.updateBuiltInAgentInactivityCleanup(custom.id, { disableAfter: 45 * DAY_MS })
    ).rejects.toThrow('not found');
  });
});

describe('a copied Agent', () => {
  it('keeps its own pair only when the duplicator may set both counts, and otherwise follows the tenant default', async () => {
    const tenant = await tenantWithCleanup(null, null);
    const caller = { tenantId: tenant.id, userId: await createUserRow(), canManageAgents: true };
    const source = await harness.agents.create(caller, { displayName: `Cleaned ${crypto.randomUUID().slice(0, 8)}` });
    await harness.agents.updateInactivityCleanup(caller, source.id, {
      disableAfter: 14 * DAY_MS,
      deleteAfter: 30 * DAY_MS,
    });

    const full = await harness.agents.duplicate(
      caller,
      source.id,
      { displayName: `Full ${crypto.randomUUID().slice(0, 8)}` },
      { canConfigureProjects: true, canDisableProjects: true, canDeleteProjects: true }
    );
    const withoutDelete = await harness.agents.duplicate(
      caller,
      source.id,
      { displayName: `Partial ${crypto.randomUUID().slice(0, 8)}` },
      { canConfigureProjects: true, canDisableProjects: true }
    );

    expect({ full: full.agent.inactivityCleanup, withoutDelete: withoutDelete.agent.inactivityCleanup }).toMatchObject({
      full: { source: 'own', cleanup: { disableAfter: 14 * DAY_MS, deleteAfter: 30 * DAY_MS } },
      withoutDelete: { source: 'default' },
    });
  });
});

it('refuses Delete after that is not later than Disable after', async () => {
  const tenant = await tenantWithCleanup(null, null);
  const project = await harness.projects.create({ title: 'Invalid' }, tenant.id);

  await expect(
    harness.projects.update(project.id, { disableAfter: 10 * DAY_MS, deleteAfter: 10 * DAY_MS }, tenant.id)
  ).rejects.toThrow('Delete after must be longer than Disable after');
});

it('refuses a count shorter than 1 hour', async () => {
  const tenant = await tenantWithCleanup(null, null);
  const project = await harness.projects.create({ title: 'Too short' }, tenant.id);

  await expect(harness.projects.update(project.id, { disableAfter: 30 * 60 * 1000 }, tenant.id)).rejects.toThrow(
    'from 1 hour to 3650 days'
  );
});

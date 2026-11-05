import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { agentPodSettings, projectPodSettings } from '../db/schema';
import { readAgentResources } from '../src/agent/agent-pod-settings';
import type { PodResources } from '../src/pod/pod-classes';
import { readPresetCatalog } from '../src/pod/resource-presets';
import type { ProjectPoolService } from '../src/pool/project-pool.service';
import { ResourcePresetService } from '../src/resource-preset/resource-preset.service';
import type { PresetRestartJobData } from '../src/resource-preset/resource-preset.types';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { createUserRow } from './support/org-fixtures';

let harness: DomainTestHarness;
const addBulk = vi.fn<Queue<PresetRestartJobData>['addBulk']>();
const presets = new ResourcePresetService(
  { addBulk } as unknown as Queue<PresetRestartJobData>,
  { reconcilePresets: vi.fn(), reconcileAgent: vi.fn() } as unknown as ProjectPoolService
);

const TINY: PodResources = { cpuMillicores: 50, memoryRequestMib: 512, memoryLimitMib: 1024 };
const TUNED: PodResources = { cpuMillicores: 150, memoryRequestMib: 1024, memoryLimitMib: 3072 };

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

async function newTenant(): Promise<string> {
  return (await harness.tenants.getOrCreateTenant(`presets-${randomUUID()}`)).id;
}

async function presetNamed(tenantId: string | null, name: string): Promise<string> {
  const preset = (await readPresetCatalog(tenantId)).presets.find((entry) => entry.name === name);
  if (!preset) throw new Error(`no preset ${name}`);
  return preset.id;
}

async function projectOn(tenantId: string, presetId: string | null = null): Promise<string> {
  const project = await harness.projects.create({ title: 'Sized' }, tenantId);
  if (presetId) await harness.projects.updatePodClass(project.id, { presetId }, tenantId);
  return project.id;
}

async function rowOf(projectId: string) {
  const [row] = await db.select().from(projectPodSettings).where(eq(projectPodSettings.projectId, projectId));
  return row;
}

describe("an Organization's own preset", () => {
  it('is offered only to that Organization and sizes the Projects that pick it', async () => {
    const tenantId = await newTenant();
    const other = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);
    const tiny = await presetNamed(tenantId, 'Tiny');

    expect((await readPresetCatalog(other)).presets.map((preset) => preset.id)).not.toContain(tiny);
    expect(await rowOf(await projectOn(tenantId, tiny))).toMatchObject({ presetId: tiny, ...TINY });
  });

  it('reaches existing Projects only when a numbers change is applied to all', async () => {
    const tenantId = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);
    const tiny = await presetNamed(tenantId, 'Tiny');
    const existing = await projectOn(tenantId, tiny);

    await presets.updatePreset(tenantId, tiny, { resources: TUNED, apply: 'new' });
    expect(await rowOf(existing)).toMatchObject(TINY);

    addBulk.mockClear();
    const applied = await presets.updatePreset(tenantId, tiny, {
      resources: { ...TUNED, cpuMillicores: 200 },
      apply: 'all',
    });
    expect(await rowOf(existing)).toMatchObject({ ...TUNED, cpuMillicores: 200 });
    expect(applied.projects).toBe(1);
    const queued = addBulk.mock.calls.flatMap(([jobs]) => jobs.map((job) => job.data.projectEnvironmentId));
    expect(queued).toHaveLength(applied.restarting);
  });

  it('reports Projects left on older numbers, and moves them all when applied later', async () => {
    const tenantId = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);
    const tiny = await presetNamed(tenantId, 'Tiny');
    const existing = await projectOn(tenantId, tiny);
    await presets.updatePreset(tenantId, tiny, { resources: TUNED, apply: 'new' });
    const behindOf = async () =>
      (await presets.organizationView(tenantId)).presets.find((preset) => preset.id === tiny)?.behind;

    expect(await behindOf()).toBe(1);

    const applied = await presets.applyPreset(tenantId, tiny);

    expect(applied.projects).toBe(1);
    expect(await rowOf(existing)).toMatchObject(TUNED);
    expect(await behindOf()).toBe(0);
  });

  it('leaves its Projects and Agents at the numbers they run at, as Custom, when deleted', async () => {
    const tenantId = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);
    const tiny = await presetNamed(tenantId, 'Tiny');
    const project = await projectOn(tenantId, tiny);
    const caller = { tenantId, userId: await createUserRow(), canManageAgents: true };
    const agent = await harness.agents.create(caller, { displayName: `Sized ${randomUUID()}` });
    await harness.agents.updatePodClass(caller, agent.id, { presetId: tiny });

    await presets.deletePreset(tenantId, tiny);

    expect(await rowOf(project)).toMatchObject({ presetId: null, ...TINY });
    const [agentRow] = await db.select().from(agentPodSettings).where(eq(agentPodSettings.agentId, agent.id));
    expect(agentRow).toMatchObject({ presetId: null, ...TINY });
  });

  it('refuses a name already used in its scope, a reserved name or numbers out of bounds', async () => {
    const tenantId = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);

    await expect(presets.createPreset(tenantId, 'tiny', TINY)).rejects.toMatchObject({ status: 409 });
    await expect(presets.createPreset(tenantId, 'Small', TINY)).rejects.toMatchObject({ status: 409 });
    await expect(presets.createPreset(tenantId, 'Custom', TINY)).rejects.toMatchObject({ status: 400 });
    await expect(presets.createPreset(tenantId, 'Huge', { ...TINY, cpuMillicores: 10 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(presets.createPreset(tenantId, 'Upside', { ...TINY, memoryLimitMib: 256 })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("an Organization's own numbers for a platform preset", () => {
  it("rewrites only that Organization's Projects when applied to all, and gives the platform numbers back", async () => {
    const tenantId = await newTenant();
    const other = await newTenant();
    const own = await projectOn(tenantId, 'large');
    const elsewhere = await projectOn(other, 'large');
    const platformLarge = await rowOf(elsewhere);

    await presets.updatePreset(tenantId, 'large', { resources: TUNED, apply: 'all' });
    expect(await rowOf(own)).toMatchObject(TUNED);
    expect(await rowOf(elsewhere)).toMatchObject({ cpuMillicores: platformLarge.cpuMillicores });

    await presets.removeOverride(tenantId, 'large', 'all');
    expect(await rowOf(own)).toMatchObject({ cpuMillicores: platformLarge.cpuMillicores });
  });

  it('cannot rename a platform preset', async () => {
    const tenantId = await newTenant();

    await expect(presets.updatePreset(tenantId, 'large', { name: 'Big' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('a platform preset', () => {
  it('reaches Organizations without their own numbers when applied to all, and is deleted to Custom', async () => {
    const following = await newTenant();
    const detached = await newTenant();
    const name = `Platform ${randomUUID().slice(0, 8)}`;
    await presets.createPreset(null, name, TINY);
    const id = await presetNamed(null, name);
    await presets.updatePreset(detached, id, { resources: TUNED, apply: 'new' });
    const followingProject = await projectOn(following, id);
    const detachedProject = await projectOn(detached, id);

    await presets.updatePreset(null, id, { resources: { ...TINY, cpuMillicores: 75 }, apply: 'all' });
    expect(await rowOf(followingProject)).toMatchObject({ cpuMillicores: 75 });
    expect(await rowOf(detachedProject)).toMatchObject(TUNED);

    await presets.deletePreset(null, id);
    expect(await rowOf(followingProject)).toMatchObject({ presetId: null, cpuMillicores: 75 });
  });

  it('refuses to delete the platform default', async () => {
    const catalog = await readPresetCatalog(null);

    await expect(presets.deletePreset(null, catalog.platformDefaultPresetId as string)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('the default preset', () => {
  it("starts an Organization's new Projects at its own default, and at the platform's once that is cleared", async () => {
    const tenantId = await newTenant();
    await presets.createPreset(tenantId, 'Tiny', TINY);
    const tiny = await presetNamed(tenantId, 'Tiny');

    await presets.setOrganizationDefault(tenantId, tiny);
    expect(await rowOf(await projectOn(tenantId))).toMatchObject({ presetId: tiny, ...TINY });

    await presets.setOrganizationDefault(tenantId, null);
    const platformDefault = (await readPresetCatalog(null)).platformDefaultPresetId;
    expect(await rowOf(await projectOn(tenantId))).toMatchObject({ presetId: platformDefault });
  });
});

describe("a Built-in Agent's Resources", () => {
  it("follow the Organization's own choice, then the platform's, then the default preset", async () => {
    const tenantId = await newTenant();
    const agentId = await harness.agents.getDefaultAgentId(tenantId);
    const caller = { tenantId, userId: await createUserRow(), canManageAgents: true };

    expect(await readAgentResources(agentId, tenantId)).toMatchObject({ source: 'default' });

    await presets.setBuiltInAgentPreset(agentId, 'medium');
    try {
      expect(await readAgentResources(agentId, tenantId)).toMatchObject({
        source: 'platform',
        resources: { presetId: 'medium' },
      });

      await harness.agents.updatePodClass(caller, agentId, { presetId: 'large' });
      expect(await readAgentResources(agentId, tenantId)).toMatchObject({
        source: 'own',
        resources: { presetId: 'large' },
        inherited: { presetId: 'medium' },
      });
      expect(await rowOf(await projectOn(tenantId))).toMatchObject({ presetId: 'large' });

      await harness.agents.resetPodClass(caller, agentId);
      expect(await readAgentResources(agentId, tenantId)).toMatchObject({ source: 'platform' });
    } finally {
      await presets.setBuiltInAgentPreset(agentId, null);
    }
  });
});

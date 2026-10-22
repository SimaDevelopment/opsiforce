import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { V1Pod } from '@kubernetes/client-node';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentPodSettings, agentSettings, projectAgentUpdates, projectEnvironments, projects } from '../../db/schema';
import { PodsOverviewService } from '../../src/admin/pods-overview.service';
import { AgentUpdateStatus } from '../../src/agent-update/agent-update.types';
import { SkillDeliveryRepository } from '../../src/delivery/skill-delivery.repository';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

/** Enough of a cluster for the overview: one pod per environment, labelled as the real one is. */
class StubPodService {
  readonly pods: V1Pod[] = [];

  assignedPodName(environmentId: string): string {
    return `opsiforce-agent-${environmentId}`;
  }

  addPodFor(environmentId: string): void {
    this.pods.push({
      metadata: {
        name: this.assignedPodName(environmentId),
        labels: { 'opsiforce.io/environment-id': environmentId },
        creationTimestamp: new Date(),
      },
      status: { phase: 'Running', podIP: '10.0.0.1' },
    });
  }

  async listPods(): Promise<V1Pod[]> {
    return this.pods;
  }

  podAgeMs(): number {
    return 0;
  }

  isPodReady(): boolean {
    return true;
  }

  inspectFailureReason(): null {
    return null;
  }
}

let harness: DomainTestHarness;
let overview: PodsOverviewService;
let pods: StubPodService;
let tenantId: string;
let userId: string;
let agentId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  pods = new StubPodService();
  overview = new PodsOverviewService(
    pods as never,
    { getKeepAliveBatch: async () => new Map() } as never,
    harness.moduleRef.get(SkillDeliveryRepository),
    { get: () => null } as never
  );
  tenantId = await createTenantRow();
  userId = await createUserRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
});

afterAll(async () => {
  await harness.close();
});

async function rowFor(projectEnvironmentId: string) {
  const view = await overview.listForTenant(tenantId);
  return view.projects
    .flatMap((group) => group.environments)
    .find((row) => row.projectEnvironmentId === projectEnvironmentId);
}

describe('an environment the Agent-Updates sweep has found behind', () => {
  it('is reported per environment in Admin until its Job resolves it', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: userId });
    pods.addPodFor(project.id);

    expect((await rowFor(project.id))?.agentUpdate).toBeNull();

    const updateId = randomUUID();
    await db.insert(projectAgentUpdates).values({
      id: updateId,
      projectId: project.id,
      projectEnvironmentId: project.id,
      agentId,
      targetVersion: '7.0.0',
      status: AgentUpdateStatus.Pending,
    });

    expect((await rowFor(project.id))?.agentUpdate).toMatchObject({
      status: AgentUpdateStatus.Pending,
      targetVersion: '7.0.0',
      requiresPodRecreate: false,
      error: null,
    });

    await db
      .update(projectAgentUpdates)
      .set({ status: AgentUpdateStatus.Failed, error: 'job exploded' })
      .where(eq(projectAgentUpdates.id, updateId));

    expect((await rowFor(project.id))?.agentUpdate).toMatchObject({
      status: AgentUpdateStatus.Failed,
      error: 'job exploded',
    });

    await db
      .update(projectAgentUpdates)
      .set({ status: AgentUpdateStatus.Applied, error: null })
      .where(eq(projectAgentUpdates.id, updateId));

    expect((await rowFor(project.id))?.agentUpdate).toBeNull();
  });
});

describe('the Ready Projects of the Organization’s Custom Agents', () => {
  async function warmSlot(slotAgentId: string, status: 'pending' | 'claiming', withPod = true): Promise<string> {
    const id = randomUUID();
    await db.insert(projects).values({ id, tenantId: null, agentId: slotAgentId });
    await db.insert(projectEnvironments).values({
      id,
      projectId: id,
      environmentId: null,
      isDefault: true,
      directory: `projects/${id}`,
      status,
      platformVersion: '0.1.0',
    });
    if (withPod) pods.addPodFor(id);
    return id;
  }

  it('lists each Agent keeping Ready Projects, its Resources, its slots and why it is paused', async () => {
    const pooled = await seedLiveAgent(tenantId, userId);
    const disabled = await seedLiveAgent(tenantId, userId, { disabled: true });
    const unpublished = await seedLiveAgent(tenantId, userId, { withProfile: false });
    await db.update(agentSettings).set({ warmPoolSize: 2 }).where(eq(agentSettings.agentId, pooled.id));
    await db.update(agentSettings).set({ warmPoolSize: 1 }).where(eq(agentSettings.agentId, disabled.id));
    await db.update(agentSettings).set({ warmPoolSize: 3 }).where(eq(agentSettings.agentId, unpublished.id));
    await db.insert(agentPodSettings).values({
      agentId: pooled.id,
      podClass: 'medium',
      cpuMillicores: 1000,
      memoryRequestMib: 4096,
      memoryLimitMib: 8192,
    });
    const ready = await warmSlot(pooled.id, 'pending');
    const claiming = await warmSlot(pooled.id, 'claiming', false);

    const { warmPool } = await overview.listForTenant(tenantId);
    const byId = new Map(warmPool.map((agent) => [agent.agentId, agent]));

    expect(byId.get(pooled.id)).toMatchObject({
      warmPoolSize: 2,
      effectiveSize: 2,
      paused: null,
      resources: { podClass: 'medium' },
      slots: [
        { projectId: ready, claiming: false, status: { phase: 'running', ready: true } },
        { projectId: claiming, claiming: true, status: null },
      ],
    });
    expect(byId.get(disabled.id)).toMatchObject({ paused: 'disabled', effectiveSize: 0, slots: [] });
    expect(byId.get(unpublished.id)).toMatchObject({ paused: 'not_published', effectiveSize: 0 });
  });

  it('leaves out Agents keeping no Ready Projects and holding no slots, and other Organizations’ Agents', async () => {
    const quiet = await seedLiveAgent(tenantId, userId);
    const elsewhere = await createTenantRow();
    await harness.environments.ensureDefaultForTenant(elsewhere);
    const foreign = await seedLiveAgent(elsewhere, userId);
    await db.update(agentSettings).set({ warmPoolSize: 2 }).where(eq(agentSettings.agentId, foreign.id));
    await warmSlot(foreign.id, 'pending');

    const ids = (await overview.listForTenant(tenantId)).warmPool.map((agent) => agent.agentId);

    expect(ids).not.toContain(quiet.id);
    expect(ids).not.toContain(foreign.id);
  });
});

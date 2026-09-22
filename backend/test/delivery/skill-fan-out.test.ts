import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, environments, projectAgentUpdates, projectSkillDeliveries, skills } from '../../db/schema';
import { AgentUpdateStatus } from '../../src/agent-update/agent-update.types';
import { DEFAULT_AGENT_NAME, type AgentCaller } from '../../src/agent/agent.types';
import {
  SKILL_DELIVERY_DEFER_DELAY_MS,
  SKILL_DELIVERY_QUEUE,
  SKILL_DELIVERY_RETRY_DELAYS_MS,
} from '../../src/delivery/delivery.types';
import { SkillsNotLive } from '../../src/delivery/pod-reload.client';
import { SkillDeliveryRepository } from '../../src/delivery/skill-delivery.repository';
import { ProjectStatus } from '../../src/project/project.types';
import type { SkillCaller } from '../../src/store/skill.service';
import { defaultEnvironmentId, ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import type { FakeQueue } from '../support/infra-fakes';
import { startFakePod, type FakePod } from '../support/fake-pod';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from '../store/support/skill-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const CONTROL_TOKEN = 'fan-out-control-token';

let pod: FakePod;
let harness: DomainTestHarness;
let queue: FakeQueue;
let state: SkillDeliveryRepository;
let tenantId: string;
let agent: AgentCaller;
let skillAuthor: SkillCaller;
let agentId: string;
let developmentId: string;
let productionId: string;

beforeAll(async () => {
  pod = await startFakePod();
  process.env.AGENT_PORT = String(pod.port);
  process.env.AGENT_CONTROL_PORT = String(pod.port);
  process.env.SKILL_DELIVERY_CONFIRM_ATTEMPTS = '2';
  process.env.SKILL_DELIVERY_CONFIRM_POLL_MS = '10';

  harness = await createDomainTestingModule();
  queue = harness.moduleRef.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
  state = harness.moduleRef.get(SkillDeliveryRepository);

  tenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  const userId = await createUserRow();
  agent = { tenantId, userId, canManageAgents: true };
  skillAuthor = { tenantId, userId, canManageSkills: true };

  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false)))
    .limit(1);
  productionId = production.id;

  agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
  await db
    .insert(agentProfiles)
    .values({ id: randomUUID(), agentId, environmentId: developmentId })
    .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });
});

afterAll(async () => {
  await harness.close();
  await pod.stop();
});

async function seedSkill(name: string, body: string): Promise<{ skillId: string; name: string }> {
  const summary = await harness.skills.create(skillAuthor, {
    name,
    files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, body) }],
  });
  // A Built-in Agent is readable by the whole Organization, so it may only carry public Skills.
  await harness.skills.setVisibility(skillAuthor, summary.id, { visibility: 'public' });
  return { skillId: summary.id, name };
}

async function republish(skillId: string, name: string, body: string): Promise<void> {
  await harness.skills.addVersion(skillAuthor, skillId, {
    files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, body) }],
  });
}

/** Three Projects across two Environments: six ProjectEnvironments for one Built-in Agent. */
async function seedSixEnvironments(): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    const publishedId = randomUUID();
    await harness.projectEnvironments.create({
      id: publishedId,
      projectId: project.id,
      environmentId: productionId,
      isDefault: false,
      directory: `projects/${publishedId}`,
      platformVersion: '0.0.0-test',
      status: ProjectStatus.Active,
    });
    ids.push(project.id, publishedId);
  }
  return ids;
}

function workspace(projectEnvironmentId: string, ...segments: string[]): string {
  return path.join(storageMountPath, 'projects', projectEnvironmentId, ...segments);
}

async function installedSkillNames(projectEnvironmentId: string): Promise<string[]> {
  const entries = await readdir(workspace(projectEnvironmentId, '.opencode/skills'), { withFileTypes: true }).catch(
    () => []
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

async function recordedSkillNames(projectEnvironmentId: string): Promise<string[]> {
  const rows = await db
    .select({ name: projectSkillDeliveries.skillName })
    .from(projectSkillDeliveries)
    .where(eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironmentId));
  return rows.map((row) => row.name).toSorted();
}

async function deliverAll(projectEnvironmentIds: string[]): Promise<void> {
  for (const projectEnvironmentId of projectEnvironmentIds) {
    await harness.skillDeliveries.deliver({ projectEnvironmentId, attempt: 0 });
  }
}

function enqueuedFor(projectEnvironmentId: string) {
  return queue
    .callsTo('add')
    .filter(
      (call) => (call.args.data as { projectEnvironmentId?: string }).projectEnvironmentId === projectEnvironmentId
    );
}

describe('a Skill mutated on a Built-in Agent', () => {
  let projectEnvironmentIds: string[];
  let skill: { skillId: string; name: string };

  beforeAll(async () => {
    projectEnvironmentIds = await seedSixEnvironments();
    skill = await seedSkill(`fanout-${randomUUID().slice(0, 8)}`, '# v1\n');
  });

  it('enqueues one deduplicated job per ProjectEnvironment in the Organization', async () => {
    const before = queue.callsTo('add').length;

    await harness.agents.setSkill(agent, agentId, skill.skillId, {});

    const added = queue.callsTo('add').slice(before);
    expect(added).toHaveLength(6);
    for (const projectEnvironmentId of projectEnvironmentIds) {
      const [call] = enqueuedFor(projectEnvironmentId);
      expect(call.args.opts).toMatchObject({ deduplication: { id: projectEnvironmentId, keepLastIfActive: true } });
    }
  });

  it('lands in every one of the six workspaces, with bookkeeping matching the directory', async () => {
    await deliverAll(projectEnvironmentIds);

    for (const projectEnvironmentId of projectEnvironmentIds) {
      expect(
        await readFile(workspace(projectEnvironmentId, `.opencode/skills/${skill.name}/SKILL.md`), 'utf8')
      ).toContain('# v1');
      expect(await recordedSkillNames(projectEnvironmentId)).toEqual(await installedSkillNames(projectEnvironmentId));
    }
  });

  it('updates the installed skill in place when the pin moves to a new version', async () => {
    const inodesBefore = await Promise.all(
      projectEnvironmentIds.map(async (id) => (await stat(workspace(id, `.opencode/skills/${skill.name}`))).ino)
    );
    await republish(skill.skillId, skill.name, '# v2\n');
    const [latest] = await db
      .select({ versionId: skills.latestVersionId })
      .from(skills)
      .where(eq(skills.id, skill.skillId));

    await harness.agents.setSkill(agent, agentId, skill.skillId, { versionId: latest.versionId ?? undefined });
    await deliverAll(projectEnvironmentIds);

    for (const [index, projectEnvironmentId] of projectEnvironmentIds.entries()) {
      expect(
        await readFile(workspace(projectEnvironmentId, `.opencode/skills/${skill.name}/SKILL.md`), 'utf8')
      ).toContain('# v2');
      // The directory itself was never replaced, so no watcher saw the skill disappear.
      expect((await stat(workspace(projectEnvironmentId, `.opencode/skills/${skill.name}`))).ino).toBe(
        inodesBefore[index]
      );
      expect(await recordedSkillNames(projectEnvironmentId)).toEqual(await installedSkillNames(projectEnvironmentId));
    }
  });

  it('skips a workspace whose content is already the desired version', async () => {
    const outcome = await harness.skillDeliveries.reconcile(projectEnvironmentIds[0]);
    expect(outcome).toEqual({ status: 'converged', written: [], deleted: [], omitted: [] });
  });

  it('deletes it from every workspace when it is removed from the Agent', async () => {
    await harness.agents.removeSkill(agent, agentId, skill.skillId);
    await deliverAll(projectEnvironmentIds);

    for (const projectEnvironmentId of projectEnvironmentIds) {
      expect(await installedSkillNames(projectEnvironmentId)).not.toContain(skill.name);
      expect(await recordedSkillNames(projectEnvironmentId)).toEqual(await installedSkillNames(projectEnvironmentId));
    }
  });

  it('reports every environment as converged through the Agent’s delivery view', async () => {
    const delivery = await harness.agents.delivery(agent, agentId);

    expect(delivery.summary).toEqual({ total: 6, converged: 6 });
    expect(delivery.environments.every((row) => row.converged)).toBe(true);
    expect(delivery.environments.map((row) => row.projectEnvironmentId).toSorted()).toEqual(
      [...projectEnvironmentIds].toSorted()
    );
    expect(delivery.environments.every((row) => row.pendingSkills.length === 0)).toBe(true);
  });
});

describe('a Skill name the workspace’s ledger owns', () => {
  it('is omitted from the fan-out and reported instead', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    const owned = await seedSkill(`owned-${randomUUID().slice(0, 8)}`, '# built-in wins\n');
    await mkdir(workspace(project.id, '.opsiforce/agents'), { recursive: true });
    await writeFile(
      workspace(project.id, `.opsiforce/agents/${DEFAULT_AGENT_NAME}.json`),
      JSON.stringify({ agentVersion: '1.0.0', ownedSkills: [owned.name] })
    );

    await harness.agents.setSkill(agent, agentId, owned.skillId, {});
    const outcome = await harness.skillDeliveries.reconcile(project.id);

    expect(outcome).toMatchObject({ status: 'converged', written: [], omitted: [owned.name] });
    expect(await recordedSkillNames(project.id)).not.toContain(owned.name);
    expect((await state.state(project.id))?.omittedSkills).toEqual([owned.name]);

    await harness.agents.removeSkill(agent, agentId, owned.skillId);
  });

  it('is written again once the package releases the name, though the delivery row never changed', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    const contested = await seedSkill(`contested-${randomUUID().slice(0, 8)}`, '# organization copy\n');
    const ledger = workspace(project.id, `.opsiforce/agents/${DEFAULT_AGENT_NAME}.json`);
    await mkdir(workspace(project.id, '.opsiforce/agents'), { recursive: true });

    await writeFile(ledger, JSON.stringify({ agentVersion: '1.0.0', ownedSkills: [] }));
    await harness.agents.setSkill(agent, agentId, contested.skillId, {});
    expect(await harness.skillDeliveries.reconcile(project.id)).toMatchObject({ written: [contested.name] });

    await writeFile(ledger, JSON.stringify({ agentVersion: '1.0.0', ownedSkills: [contested.name] }));
    await rm(workspace(project.id, `.opencode/skills/${contested.name}`), { recursive: true, force: true });
    expect(await harness.skillDeliveries.reconcile(project.id)).toMatchObject({ omitted: [contested.name] });

    await writeFile(ledger, JSON.stringify({ agentVersion: '1.0.0', ownedSkills: [] }));
    expect(await harness.skillDeliveries.reconcile(project.id)).toMatchObject({
      written: [contested.name],
      omitted: [],
    });
    expect(await installedSkillNames(project.id)).toContain(contested.name);

    await harness.agents.removeSkill(agent, agentId, contested.skillId);
  });
});

describe('a Custom Agent’s Project', () => {
  it('is never enqueued by a Skill mutation and is skipped if a job reaches it anyway', async () => {
    const custom = await seedLiveAgent(tenantId, agent.userId);
    const skill = await seedSkill(`custom-${randomUUID().slice(0, 8)}`, '# frozen\n');
    await harness.agents.setSkill(agent, custom.id, skill.skillId, {});
    const project = await harness.projects.create({ agentId: custom.id }, tenantId, { createdBy: agent.userId });

    const before = queue.callsTo('add').length;
    await harness.agents.setSkill(agent, custom.id, skill.skillId, {});

    expect(queue.callsTo('add').slice(before)).toEqual([]);
    expect(await harness.skillDeliveries.reconcile(project.id)).toEqual({
      status: 'skipped',
      reason: 'custom-agent',
    });
  });
});

describe('the per-environment critical section', () => {
  it('defers while an Agent-Updates row is running and lands once the Job finishes', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    const skill = await seedSkill(`deferred-${randomUUID().slice(0, 8)}`, '# after the job\n');
    await harness.agents.setSkill(agent, agentId, skill.skillId, {});

    const updateId = randomUUID();
    await db.insert(projectAgentUpdates).values({
      id: updateId,
      projectId: project.id,
      projectEnvironmentId: project.id,
      agentId,
      targetVersion: '1.0.0',
      status: AgentUpdateStatus.Running,
      startedAt: new Date(),
    });

    const deferred = await harness.skillDeliveries.deliver({ projectEnvironmentId: project.id, attempt: 0 });

    expect(deferred).toEqual({ status: 'deferred', reason: 'agent-update-running' });
    expect(await installedSkillNames(project.id)).not.toContain(skill.name);
    expect(enqueuedFor(project.id).at(-1)?.args.opts).toMatchObject({ delay: SKILL_DELIVERY_DEFER_DELAY_MS });

    await db
      .update(projectAgentUpdates)
      .set({ status: AgentUpdateStatus.Applied })
      .where(eq(projectAgentUpdates.id, updateId));

    const landed = await harness.skillDeliveries.deliver({ projectEnvironmentId: project.id, attempt: 0 });

    expect(landed).toMatchObject({ status: 'converged', written: [skill.name] });
    expect(await installedSkillNames(project.id)).toContain(skill.name);

    await harness.agents.removeSkill(agent, agentId, skill.skillId);
  });

  it('does not treat a row older than the reaper’s window as a claim', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    const skill = await seedSkill(`unblocked-${randomUUID().slice(0, 8)}`, '# unblocked\n');
    await harness.agents.setSkill(agent, agentId, skill.skillId, {});
    await db.insert(projectAgentUpdates).values({
      id: randomUUID(),
      projectId: project.id,
      projectEnvironmentId: project.id,
      agentId,
      targetVersion: '1.0.0',
      status: AgentUpdateStatus.Running,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // `reconcile` skips the boot reap, so only the staleness cutoff can let this through.
    expect(await harness.skillDeliveries.reconcile(project.id)).toMatchObject({
      status: 'converged',
      written: [skill.name],
    });

    await harness.agents.removeSkill(agent, agentId, skill.skillId);
  });

  /** The reap happens once per process, so this needs a service that has not delivered yet. */
  it('reaps a row a dead process left running before it writes anything', async () => {
    const booting = await createDomainTestingModule();
    try {
      const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
      const skill = await seedSkill(`reaped-${randomUUID().slice(0, 8)}`, '# reaped\n');
      await harness.agents.setSkill(agent, agentId, skill.skillId, {});

      const stale = randomUUID();
      const fresh = randomUUID();
      await db.insert(projectAgentUpdates).values([
        {
          id: stale,
          projectId: project.id,
          projectEnvironmentId: project.id,
          agentId,
          targetVersion: '1.0.0',
          status: AgentUpdateStatus.Running,
          startedAt: new Date(Date.now() - 20 * 60 * 1000),
        },
        {
          id: fresh,
          projectId: project.id,
          projectEnvironmentId: null,
          agentId,
          targetVersion: '1.0.0',
          status: AgentUpdateStatus.Running,
          startedAt: new Date(),
        },
      ]);

      const outcome = await booting.skillDeliveries.deliver({ projectEnvironmentId: project.id, attempt: 0 });

      const rows = await db
        .select({ id: projectAgentUpdates.id, status: projectAgentUpdates.status, error: projectAgentUpdates.error })
        .from(projectAgentUpdates)
        .where(eq(projectAgentUpdates.projectId, project.id));
      expect(rows.find((row) => row.id === stale)).toMatchObject({
        status: AgentUpdateStatus.Failed,
        error: 'process_terminated',
      });
      expect(rows.find((row) => row.id === fresh)).toMatchObject({ status: AgentUpdateStatus.Running });
      expect(outcome).toMatchObject({ status: 'converged', written: [skill.name] });

      await harness.agents.removeSkill(agent, agentId, skill.skillId);
    } finally {
      await booting.close();
    }
  });
});

describe('a running pod', () => {
  let project: { id: string };
  let skill: { skillId: string; name: string };

  beforeAll(async () => {
    project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    skill = await seedSkill(`live-${randomUUID().slice(0, 8)}`, '# live\n');
    await harness.agents.setSkill(agent, agentId, skill.skillId, {});
  });

  beforeEach(async () => {
    harness.fakes.pods.setPod(harness.fakes.pods.assignedPodName(project.id), '127.0.0.1', CONTROL_TOKEN);
    await harness.projectEnvironments.patch(project.id, { status: ProjectStatus.Active, podIp: '127.0.0.1' });
  });

  it('is notified locally and the delivery is confirmed against what it serves', async () => {
    pod.serveSkills(() => installedSkillNames(project.id));
    const notifiedBefore = pod.requestsTo('notify.configChange').length;
    const listedBefore = pod.requestsTo('skill.list').length;

    const outcome = await harness.skillDeliveries.reconcile(project.id);

    expect(outcome).toMatchObject({ status: 'converged', written: [skill.name] });
    const [notify] = pod.requestsTo('notify.configChange').slice(notifiedBefore);
    expect(notify.body).toEqual({ targets: ['skills'] });
    expect(notify.headers['x-control-token']).toBe(CONTROL_TOKEN);
    expect(pod.requestsTo('skill.list').length).toBeGreaterThan(listedBefore);
  });

  it('fails the run when it never serves the delivered skill, and retries on the ladder', async () => {
    const stubborn = await seedSkill(`unseen-${randomUUID().slice(0, 8)}`, '# unseen\n');
    await harness.agents.setSkill(agent, agentId, stubborn.skillId, {});
    pod.serveSkills(() => []);

    await expect(harness.skillDeliveries.reconcile(project.id)).rejects.toThrow(SkillsNotLive);

    // The bytes are on disk and recorded; only the pod's view of them is missing.
    expect(await recordedSkillNames(project.id)).toEqual(await installedSkillNames(project.id));

    await harness.skillDeliveries.recordFailure({ projectEnvironmentId: project.id, attempt: 0 }, 'not live');
    const recorded = await state.state(project.id);
    expect(recorded?.converged).toBe(false);
    expect(recorded?.failedAt).not.toBeNull();
    expect(enqueuedFor(project.id).at(-1)?.args.opts).toMatchObject({ delay: SKILL_DELIVERY_RETRY_DELAYS_MS[0] });

    const delivery = await harness.agents.delivery(agent, agentId);
    const row = delivery.environments.find((entry) => entry.projectEnvironmentId === project.id);
    expect(row).toMatchObject({ converged: false, error: 'not live' });
    expect(delivery.summary.converged).toBeLessThan(delivery.summary.total);

    await harness.agents.removeSkill(agent, agentId, stubborn.skillId);
  });
});

describe('a suspended environment', () => {
  it('is written to now and left for its next ensure to confirm', async () => {
    const project = await harness.projects.create({ agentId }, tenantId, { createdBy: agent.userId });
    await harness.projectEnvironments.patch(project.id, { status: ProjectStatus.Suspended, podIp: null });
    const skill = await seedSkill(`suspended-${randomUUID().slice(0, 8)}`, '# suspended\n');
    await harness.agents.setSkill(agent, agentId, skill.skillId, {});

    const outcome = await harness.skillDeliveries.reconcile(project.id);

    expect(outcome).toMatchObject({ status: 'converged', written: [skill.name] });
    expect(await installedSkillNames(project.id)).toContain(skill.name);

    await harness.agents.removeSkill(agent, agentId, skill.skillId);
  });
});

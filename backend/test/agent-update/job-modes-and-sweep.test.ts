import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, agents, environments, projectAgentUpdates } from '../../db/schema';
import { AgentUpdateProcessor } from '../../src/agent-update/agent-update.processor';
import type { AgentUpdateJobOptions, AgentUpdateRunResult } from '../../src/agent-update/agent-update.k8s.service';
import { reapStaleRunningAgentUpdates } from '../../src/agent-update/agent-update.reaper';
import { AgentUpdateService } from '../../src/agent-update/agent-update.service';
import {
  AGENT_WORKSPACE_UPDATE_QUEUE,
  AgentUpdateStatus,
  type AgentEnvironmentJobData,
} from '../../src/agent-update/agent-update.types';
import { DEFAULT_AGENT_NAME, type AgentCaller } from '../../src/agent/agent.types';
import { CUSTOM_AGENT_PACKAGE } from '../../src/delivery/delivery.types';
import { ProjectStatus } from '../../src/project/project.types';
import type { SkillCaller } from '../../src/store/skill.service';
import { defaultEnvironmentId, ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import type { FakeQueue } from '../support/infra-fakes';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from '../store/support/skill-fixtures';

const run = promisify(execFile);
const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const MIGRATE_SCRIPT = path.resolve('../agent-config/scripts/agent-workspace-migrate.mjs');
const BUILT_IN_PACKAGE = DEFAULT_AGENT_NAME;

class ScriptJobRunner {
  readonly runs: AgentUpdateJobOptions[] = [];
  aliveJobIds = new Set<string>();
  imageRoot = '';

  async run(options: AgentUpdateJobOptions): Promise<AgentUpdateRunResult> {
    this.runs.push(options);
    const args = [MIGRATE_SCRIPT, '--reconcile-content', ...(options.mode === 'full' ? ['--migrate'] : [])];
    try {
      const { stdout } = await run(process.execPath, args, {
        env: {
          ...process.env,
          AGENT_NAME: options.packageName,
          TARGET_VERSION: options.targetVersion,
          WORKSPACE: path.join(storageMountPath, options.directory),
          AGENTS_ROOT: path.join(this.imageRoot, 'agents'),
          OPENCODE_ROOT: path.join(this.imageRoot, 'opencode'),
        },
      });
      return { logs: stdout, succeeded: true };
    } catch (err) {
      return { logs: (err as { stdout?: string }).stdout ?? '', succeeded: false };
    }
  }

  async isJobRunning(updateId: string): Promise<boolean> {
    return this.aliveJobIds.has(updateId);
  }
}

let harness: DomainTestHarness;
let queue: FakeQueue;
let runner: ScriptJobRunner;
let processor: AgentUpdateProcessor;
let tenantId: string;
let userId: string;
let agent: AgentCaller;
let skillAuthor: SkillCaller;
let builtInAgentId: string;
let developmentId: string;
let productionId: string;
let imageRoot: string;
let imageVersion = '0.1.0';

beforeAll(async () => {
  harness = await createDomainTestingModule();
  queue = harness.moduleRef.get<FakeQueue>(getQueueToken(AGENT_WORKSPACE_UPDATE_QUEUE));
  runner = new ScriptJobRunner();

  tenantId = await createTenantRow();
  userId = await createUserRow();
  agent = { tenantId, userId, canManageAgents: true };
  skillAuthor = { tenantId, userId, canManageSkills: true };
  await harness.environments.ensureDefaultForTenant(tenantId);
  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false)))
    .limit(1);
  productionId = production.id;

  builtInAgentId = await ensureBuiltInAgent(BUILT_IN_PACKAGE);
  await db
    .insert(agentProfiles)
    .values({ id: randomUUID(), agentId: builtInAgentId, environmentId: developmentId })
    .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });

  imageRoot = await mkdtemp(path.join(tmpdir(), 'agent-image-'));
  runner.imageRoot = imageRoot;
  await layImage('1.0.0', '# platform v1\n');
});

function rebuildProcessor(): void {
  const config = harness.moduleRef.get(ConfigService);
  const withImageVersion = {
    get: (key: string, fallback?: unknown) => (key === 'agentImageVersion' ? imageVersion : config.get(key, fallback)),
    getOrThrow: (key: string) => (key === 'agentImageVersion' ? imageVersion : config.getOrThrow(key)),
  };
  processor = new AgentUpdateProcessor(
    harness.moduleRef.get(AgentUpdateService),
    runner as never,
    harness.projectEnvironments,
    harness.skillDeliveries,
    withImageVersion as never
  );
}

afterAll(async () => {
  await harness.close();
  await rm(imageRoot, { recursive: true, force: true });
});

/** The agent image: one built-in package with a `platform` skill, plus the `custom` package. */
async function layImage(version: string, platformSkill: string, nextImageVersion?: string): Promise<void> {
  imageVersion = nextImageVersion ?? imageVersion;
  const agentsRoot = path.join(imageRoot, 'agents');
  const opencodeRoot = path.join(imageRoot, 'opencode');
  await mkdir(opencodeRoot, { recursive: true });
  await writeFile(
    path.join(opencodeRoot, 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', update: 'disable' })
  );
  await writeFile(path.join(opencodeRoot, 'agent-image-version.json'), JSON.stringify({ version: imageVersion }));
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(path.join(agentsRoot, 'agents.json'), JSON.stringify({ agents: { [BUILT_IN_PACKAGE]: { version } } }));

  for (const name of [BUILT_IN_PACKAGE, CUSTOM_AGENT_PACKAGE]) {
    await mkdir(path.join(agentsRoot, name, 'skills', 'platform'), { recursive: true });
    await writeFile(path.join(agentsRoot, name, 'skills', 'platform', 'SKILL.md'), platformSkill);
  }
  await writeFile(path.join(agentsRoot, BUILT_IN_PACKAGE, 'agent.md'), `# ${BUILT_IN_PACKAGE}\n`);
  await setRegistryVersion(version);
  rebuildProcessor();
}

async function setRegistryVersion(version: string): Promise<void> {
  await db.update(agents).set({ version }).where(eq(agents.id, builtInAgentId));
}

async function writeMigration(id: string, requiresPodRecreate: boolean): Promise<void> {
  const dir = path.join(imageRoot, 'agents', BUILT_IN_PACKAGE, 'migrations', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'payload.txt'), `${id}\n`);
  await writeFile(
    path.join(dir, 'migration.json'),
    JSON.stringify({
      id,
      requiresPodRecreate,
      operations: [{ type: 'copy', source: 'payload.txt', target: `app/${id}.txt` }],
    })
  );
}

async function publishedEnvironmentFor(projectId: string): Promise<string> {
  const id = randomUUID();
  await harness.projectEnvironments.create({
    id,
    projectId,
    environmentId: productionId,
    isDefault: false,
    directory: `projects/${id}`,
    platformVersion: '0.0.0-test',
    status: ProjectStatus.Active,
  });
  return id;
}

/** Drives the sweep and then every environment job it enqueued, as the worker would. */
async function sweep(): Promise<AgentEnvironmentJobData[]> {
  const before = queue.callsTo('addBulk').length;
  await processor.process({ name: 'sweep', data: {} } as Job);
  const enqueued = queue
    .callsTo('addBulk')
    .slice(before)
    .flatMap((call) => (call.args.jobs as unknown as Array<{ data: AgentEnvironmentJobData }>).map((job) => job.data));
  for (const data of enqueued) {
    await processor.process({ name: 'environment', data } as unknown as Job).catch(() => undefined);
  }
  return enqueued;
}

function workspace(projectEnvironmentId: string, ...segments: string[]): string {
  return path.join(storageMountPath, 'projects', projectEnvironmentId, ...segments);
}

async function ledgerOf(projectEnvironmentId: string, packageName: string) {
  const raw = await readFile(workspace(projectEnvironmentId, `.opsiforce/agents/${packageName}.json`), 'utf8');
  return JSON.parse(raw) as { package: string; contentVersion: string; ownedSkills: string[] };
}

async function latestRow(projectEnvironmentId: string) {
  const [row] = await db
    .select()
    .from(projectAgentUpdates)
    .where(eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId))
    .orderBy(desc(projectAgentUpdates.createdAt));
  return row;
}

async function rowsFor(projectEnvironmentId: string) {
  return db
    .select()
    .from(projectAgentUpdates)
    .where(eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId));
}

describe('an agent image bump', () => {
  let builtInProject: { id: string };
  let publishedId: string;
  let customProject: { id: string };
  let customSlug: string;
  let customPrompt: string;
  let customSkillNames: string[];

  beforeAll(async () => {
    builtInProject = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    publishedId = await publishedEnvironmentFor(builtInProject.id);

    const custom = await seedLiveAgent(tenantId, userId);
    customSlug = custom.name;
    const skillName = `snapshot-${randomUUID().slice(0, 8)}`;
    const skill = await harness.skills.create(skillAuthor, {
      name: skillName,
      files: [
        {
          path: 'SKILL.md',
          content: manifest(`name: ${skillName}\ndescription: ${validDescription}`, '# snapshot\n'),
        },
      ],
    });
    await harness.skills.setVisibility(skillAuthor, skill.id, { visibility: 'public' });
    await harness.agents.setSkill(agent, custom.id, skill.id, {});
    customProject = await harness.projects.create({ agentId: custom.id }, tenantId, { createdBy: userId });
    customSkillNames = [skillName];

    await sweep();
    customPrompt = await readFile(workspace(customProject.id, `.opencode/agents/${customSlug}.md`), 'utf8');
  });

  it('reaches every ProjectEnvironment, in `full` on Development and `content` elsewhere', async () => {
    await layImage('1.1.0', '# platform v2\n', '0.2.0');

    const enqueued = await sweep();

    const modes = new Map(enqueued.map((job) => [job.projectEnvironmentId, job]));
    expect(modes.get(builtInProject.id)).toMatchObject({ mode: 'full', packageName: BUILT_IN_PACKAGE });
    expect(modes.get(publishedId)).toMatchObject({ mode: 'content', packageName: BUILT_IN_PACKAGE });
    expect(modes.get(customProject.id)).toMatchObject({ mode: 'full', packageName: CUSTOM_AGENT_PACKAGE });

    for (const id of [builtInProject.id, publishedId, customProject.id]) {
      expect(await readFile(workspace(id, '.opencode/skills/platform/SKILL.md'), 'utf8')).toBe('# platform v2\n');
    }
  });

  it('never asks for a pod recreate for a content-only bump', async () => {
    for (const id of [builtInProject.id, publishedId, customProject.id]) {
      const row = await latestRow(id);
      expect(row.requiresPodRecreate).toBe(false);
      expect(row.status).toBe(AgentUpdateStatus.Applied);
    }
  });

  it('leaves a Custom Agent Project’s prompt and pinned skills byte-identical', async () => {
    expect(await readFile(workspace(customProject.id, `.opencode/agents/${customSlug}.md`), 'utf8')).toBe(
      customPrompt
    );
    for (const name of customSkillNames) {
      expect(await readFile(workspace(customProject.id, `.opencode/skills/${name}/SKILL.md`), 'utf8')).toContain(
        '# snapshot'
      );
    }
  });

  it('versions a Custom Agent Project by the agent image version', async () => {
    const ledger = await ledgerOf(customProject.id, CUSTOM_AGENT_PACKAGE);
    expect(ledger.package).toBe(CUSTOM_AGENT_PACKAGE);
    expect(ledger.contentVersion).toBe('0.2.0');
  });

  it('retires the ledger’s legacy keys', async () => {
    const raw = JSON.parse(
      await readFile(workspace(builtInProject.id, `.opsiforce/agents/${BUILT_IN_PACKAGE}.json`), 'utf8')
    ) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('agentName');
    expect(raw).not.toHaveProperty('agentVersion');
    expect(raw.contentVersion).toBe('1.1.0');
  });

  it('skips a workspace already at the target on the next sweep', async () => {
    expect(await sweep()).toEqual([]);
  });
});

describe('a migration-carrying bump', () => {
  let project: { id: string };
  let publishedId: string;

  beforeAll(async () => {
    project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    publishedId = await publishedEnvironmentFor(project.id);
    await sweep();

    await writeMigration('0001-baked-binary', true);
    await layImage('2.0.0', '# platform v3\n');
    await sweep();
  });

  it('applies the migration on Development only', async () => {
    const development = await latestRow(project.id);
    const published = await latestRow(publishedId);

    expect(development.appliedMigrations).toEqual(['0001-baked-binary']);
    expect(published.appliedMigrations).toEqual([]);
    expect(await readFile(workspace(project.id, 'app/0001-baked-binary.txt'), 'utf8')).toBe('0001-baked-binary\n');
    await expect(readFile(workspace(publishedId, 'app/0001-baked-binary.txt'), 'utf8')).rejects.toThrow();
  });

  it('takes requiresPodRecreate from the migration and from nowhere else', async () => {
    expect(await latestRow(project.id)).toMatchObject({
      requiresPodRecreate: true,
      status: AgentUpdateStatus.ReloadPending,
    });
    expect(await latestRow(publishedId)).toMatchObject({
      requiresPodRecreate: false,
      status: AgentUpdateStatus.Applied,
    });
  });

  it('still delivers the content change to the published environment', async () => {
    expect(await readFile(workspace(publishedId, '.opencode/skills/platform/SKILL.md'), 'utf8')).toBe(
      '# platform v3\n'
    );
  });
});

describe('an environment the sweep has found behind', () => {
  it('is recorded as pending before the Job runs and is visible per environment in Admin', async () => {
    const project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    await sweep();
    await layImage('3.0.0', '# platform v4\n');

    // The sweep alone: the workspace is behind and nothing has written to it yet.
    await processor.process({ name: 'sweep', data: {} } as Job);

    const open = (await rowsFor(project.id)).filter((row) => row.status === AgentUpdateStatus.Pending);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ targetVersion: '3.0.0', projectId: project.id });

    // A second sweep before the Job lands does not stack a second outstanding row.
    await processor.process({ name: 'sweep', data: {} } as Job);
    expect((await rowsFor(project.id)).filter((row) => row.status === AgentUpdateStatus.Pending)).toHaveLength(1);
  });

  it('retires a pending row whose target has since moved on', async () => {
    const project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    await sweep();

    // A sweep that records the environment as behind, and a backend that dies before the Job runs.
    await layImage('3.5.0', '# platform v7\n');
    await processor.process({ name: 'sweep', data: {} } as Job);
    await layImage('3.6.0', '# platform v8\n');

    await sweep();

    const open = (await rowsFor(project.id)).filter((row) => row.status === AgentUpdateStatus.Pending);
    expect(open).toEqual([]);
    expect(
      (await rowsFor(project.id)).find((row) => row.targetVersion === '3.6.0')?.status
    ).toBe(AgentUpdateStatus.Applied);
  });

  it('takes that row over rather than opening a second one when the Job runs', async () => {
    const project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    await sweep();
    await layImage('3.1.0', '# platform v5\n');

    await sweep();

    const rows = (await rowsFor(project.id)).filter((row) => row.targetVersion === '3.1.0');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(AgentUpdateStatus.Applied);
  });
});

describe('the bootstrap reaper', () => {
  it('resolves a surviving Kubernetes Job instead of failing its row blindly', async () => {
    const project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    const surviving = randomUUID();
    const orphaned = randomUUID();
    const longAgo = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(projectAgentUpdates).values([
      {
        id: surviving,
        projectId: project.id,
        projectEnvironmentId: project.id,
        agentId: builtInAgentId,
        targetVersion: '9.0.0',
        status: AgentUpdateStatus.Running,
        startedAt: longAgo,
      },
      {
        id: orphaned,
        projectId: project.id,
        projectEnvironmentId: null,
        agentId: builtInAgentId,
        targetVersion: '9.0.0',
        status: AgentUpdateStatus.Running,
        startedAt: longAgo,
      },
    ]);
    runner.aliveJobIds = new Set([surviving]);

    await reapStaleRunningAgentUpdates(15 * 60 * 1000, (updateId) => runner.isJobRunning(updateId));

    const rows = await db
      .select()
      .from(projectAgentUpdates)
      .where(eq(projectAgentUpdates.projectId, project.id));
    const kept = rows.find((row) => row.id === surviving);
    const reaped = rows.find((row) => row.id === orphaned);
    expect(kept).toMatchObject({ status: AgentUpdateStatus.Running, error: null });
    // Its clock restarted, so the claim on that workspace is not immediately stale again.
    expect(kept?.startedAt?.getTime()).toBeGreaterThan(longAgo.getTime());
    expect(reaped).toMatchObject({ status: AgentUpdateStatus.Failed, error: 'process_terminated' });

    runner.aliveJobIds = new Set();
    await db.delete(projectAgentUpdates).where(eq(projectAgentUpdates.projectId, project.id));
  });
});

describe('the environment critical section', () => {
  it('spans the Job and its post-Job reconcile, and a fan-out defers across both', async () => {
    const project = await harness.projects.create({ agentId: builtInAgentId }, tenantId, { createdBy: userId });
    await sweep();

    const skillName = `inline-${randomUUID().slice(0, 8)}`;
    const skill = await harness.skills.create(skillAuthor, {
      name: skillName,
      files: [
        {
          path: 'SKILL.md',
          content: manifest(`name: ${skillName}\ndescription: ${validDescription}`, '# inline\n'),
        },
      ],
    });
    await harness.skills.setVisibility(skillAuthor, skill.id, { visibility: 'public' });
    await harness.agents.setSkill(agent, builtInAgentId, skill.id, {});
    await rm(workspace(project.id, `.opencode/skills/${skillName}`), { recursive: true, force: true });

    await layImage('4.0.0', '# platform v6\n');
    await sweep();

    // The reconcile ran inside the Job's claim, so the Skill is on disk without a separate run.
    expect(await readFile(workspace(project.id, `.opencode/skills/${skillName}/SKILL.md`), 'utf8')).toContain(
      '# inline'
    );

    // And while a row is running, only its own holder may write.
    const holder = randomUUID();
    await db.insert(projectAgentUpdates).values({
      id: holder,
      projectId: project.id,
      projectEnvironmentId: project.id,
      agentId: builtInAgentId,
      targetVersion: '4.0.0',
      status: AgentUpdateStatus.Running,
      startedAt: new Date(),
    });

    expect(await harness.skillDeliveries.reconcile(project.id)).toEqual({
      status: 'deferred',
      reason: 'agent-update-running',
    });
    expect(await harness.skillDeliveries.reconcile(project.id, { holdingUpdateId: holder })).toMatchObject({
      status: 'converged',
    });

    await db.delete(projectAgentUpdates).where(eq(projectAgentUpdates.id, holder));
    await harness.agents.removeSkill(agent, builtInAgentId, skill.id);
  });
});

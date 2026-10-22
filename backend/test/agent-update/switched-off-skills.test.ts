import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { AgentUpdateProcessor } from '../../src/agent-update/agent-update.processor';
import type { AgentUpdateJobOptions, AgentUpdateRunResult } from '../../src/agent-update/agent-update.k8s.service';
import { AgentUpdateService } from '../../src/agent-update/agent-update.service';
import { AGENT_WORKSPACE_UPDATE_QUEUE, type AgentEnvironmentJobData } from '../../src/agent-update/agent-update.types';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import { SkillSwitchRepository } from '../../src/delivery/skill-switch.repository';
import { ensureBuiltInAgent } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import type { FakeQueue } from '../support/infra-fakes';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

const run = promisify(execFile);
const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const MIGRATE_SCRIPT = path.resolve('../agent-config/scripts/agent-workspace-migrate.mjs');
const PACKAGE = DEFAULT_AGENT_NAME;

class ScriptJobRunner {
  readonly runs: AgentUpdateJobOptions[] = [];
  imageRoot = '';

  async run(options: AgentUpdateJobOptions): Promise<AgentUpdateRunResult> {
    this.runs.push(options);
    try {
      const { stdout } = await run(process.execPath, [MIGRATE_SCRIPT, '--reconcile-content'], {
        env: {
          ...process.env,
          AGENT_NAME: options.packageName,
          TARGET_VERSION: options.targetVersion,
          WORKSPACE: path.join(storageMountPath, options.directory),
          AGENTS_ROOT: path.join(this.imageRoot, 'agents'),
          OPENCODE_ROOT: path.join(this.imageRoot, 'opencode'),
          SWITCHED_OFF_SKILLS: options.switchedOffSkills.join(','),
        },
      });
      return { logs: stdout, succeeded: true };
    } catch (err) {
      return { logs: (err as { stdout?: string }).stdout ?? '', succeeded: false };
    }
  }

  async isJobRunning(): Promise<boolean> {
    return false;
  }
}

const podReload = {
  async notify(): Promise<boolean> {
    return true;
  },
  async confirmSkills(): Promise<void> {},
};

let harness: DomainTestHarness;
let queue: FakeQueue;
let runner: ScriptJobRunner;
let processor: AgentUpdateProcessor;
let switches: SkillSwitchRepository;
let agentId: string;
let tenantId: string;
let userId: string;
let imageRoot: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  queue = harness.moduleRef.get<FakeQueue>(getQueueToken(AGENT_WORKSPACE_UPDATE_QUEUE));
  switches = harness.moduleRef.get(SkillSwitchRepository);
  runner = new ScriptJobRunner();
  tenantId = await createTenantRow();
  userId = await createUserRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  agentId = await ensureBuiltInAgent(PACKAGE);
  imageRoot = await mkdtemp(path.join(tmpdir(), 'agent-image-'));
  runner.imageRoot = imageRoot;
  processor = new AgentUpdateProcessor(
    harness.moduleRef.get(AgentUpdateService),
    runner as never,
    harness.projectEnvironments,
    harness.skillDeliveries,
    harness.moduleRef.get(ConfigService),
    podReload as never,
    switches
  );
});

afterAll(async () => {
  await harness.close();
  await rm(imageRoot, { recursive: true, force: true });
});

async function layImage(version: string): Promise<void> {
  const packageRoot = path.join(imageRoot, 'agents', PACKAGE);
  await mkdir(path.join(imageRoot, 'opencode'), { recursive: true });
  await mkdir(path.join(imageRoot, 'agents'), { recursive: true });
  await writeFile(path.join(imageRoot, 'opencode', 'opencode.json'), JSON.stringify({ update: 'disable' }));
  await writeFile(
    path.join(imageRoot, 'agents', 'agents.json'),
    JSON.stringify({ agents: { [PACKAGE]: { version } } })
  );
  for (const name of ['platform', 'brand-kit']) {
    await mkdir(path.join(packageRoot, 'skills', name), { recursive: true });
    await writeFile(path.join(packageRoot, 'skills', name, 'SKILL.md'), `# ${name} ${version}\n`);
  }
  await writeFile(path.join(packageRoot, 'agent.md'), `# ${PACKAGE}\n`);
  await db.update(agents).set({ version }).where(eq(agents.id, agentId));
}

async function sweep(): Promise<void> {
  const before = queue.acceptedJobs.length;
  await processor.process({ name: 'sweep', data: {} } as Job);
  const enqueued = queue.acceptedJobs
    .slice(before)
    .map((job) => (job as unknown as { data: AgentEnvironmentJobData }).data);
  for (const data of enqueued) {
    await processor.process({ name: 'environment', data } as unknown as Job).catch(() => undefined);
  }
}

function workspace(projectEnvironmentId: string, ...segments: string[]): string {
  return path.join(storageMountPath, 'projects', projectEnvironmentId, ...segments);
}

async function installedSkillNames(projectEnvironmentId: string): Promise<string[]> {
  const entries = await readdir(workspace(projectEnvironmentId, '.opencode/skills'), { withFileTypes: true }).catch(
    () => []
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function ownedSkills(projectEnvironmentId: string): Promise<string[]> {
  const ledger = JSON.parse(
    await readFile(workspace(projectEnvironmentId, `.opsiforce/agents/${PACKAGE}.json`), 'utf8')
  ) as { ownedSkills: string[] };
  return ledger.ownedSkills;
}

describe('the Agent Updates Job in an environment that switched a package Skill off', () => {
  let projectId: string;

  beforeAll(async () => {
    await layImage('9.0.0');
    projectId = (await harness.projects.create({ agentId }, tenantId, { createdBy: userId })).id;
    await sweep();
    expect(await installedSkillNames(projectId)).toContain('brand-kit');
  });

  it('is handed the switched-off list and skips that Skill', async () => {
    await switches.switchOff(projectId, 'brand-kit', null);
    await layImage('9.1.0');

    await sweep();

    const lastRun = runner.runs.findLast((options) => options.projectEnvironmentId === projectId);
    expect(lastRun).toMatchObject({ switchedOffSkills: ['brand-kit'] });
    expect(await installedSkillNames(projectId)).not.toContain('brand-kit');
    expect(await installedSkillNames(projectId)).toContain('platform');
    expect(await ownedSkills(projectId)).not.toContain('brand-kit');
  });

  it('lays it again on the next release once switched back on', async () => {
    await switches.switchOn(projectId, 'brand-kit');
    await layImage('9.2.0');

    await sweep();

    expect(await readFile(workspace(projectId, '.opencode/skills/brand-kit/SKILL.md'), 'utf8')).toBe(
      '# brand-kit 9.2.0\n'
    );
    expect(await ownedSkills(projectId)).toContain('brand-kit');
  });
});

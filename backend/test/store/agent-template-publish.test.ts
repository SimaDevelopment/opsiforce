import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, environments, projects } from '../../db/schema';
import type { AgentCaller } from '../../src/agent/agent.types';
import type { AgentService } from '../../src/agent/agent.service';
import { AgentTemplateStore } from '../../src/agent-template/agent-template.store';
import { WorkspaceCleanupProcessor, type WorkspaceCleanupJobData } from '../../src/cleanup/workspace-cleanup.processor';
import { configuration } from '../../src/config/configuration';
import { lockAgentTemplate } from '../../src/common/locks';
import { HostPathDirectoryUsageStrategy } from '../../src/storage/hostpath-directory-usage.strategy';
import { PlatformStorageSnapshotService } from '../../src/storage/platform-storage-snapshot.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import {
  agentTemplatesDir,
  defaultEnvironmentId,
  ensureBuiltInSkill,
  seedBuilderChat,
} from '../support/agent-fixtures';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

let harness: DomainTestHarness;
let service: AgentService;
let cleanup: WorkspaceCleanupProcessor;
let snapshots: PlatformStorageSnapshotService;

interface Organization {
  author: AgentCaller;
  developmentId: string;
  productionId: string;
}

let org: Organization;

async function organization(): Promise<Organization> {
  const tenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false)))
    .limit(1);
  return {
    author: { tenantId, userId: await createUserRow(), canManageAgents: true },
    developmentId: await defaultEnvironmentId(tenantId),
    productionId: production.id,
  };
}

beforeAll(async () => {
  harness = await createDomainTestingModule();
  service = harness.agents;
  const config = new ConfigService(configuration());
  cleanup = new WorkspaceCleanupProcessor(config, new AgentTemplateStore(config));
  snapshots = new PlatformStorageSnapshotService(config, new HostPathDirectoryUsageStrategy(config));
  await ensureBuiltInSkill('platform');
  org = await organization();
});

async function runDailyCleanup(): Promise<void> {
  await cleanup.process({ data: {} } as Job<WorkspaceCleanupJobData>);
}

afterAll(async () => {
  await harness.close();
});

interface Authoring {
  agentId: string;
  templateDir: string;
  write: (path: string, content?: string) => Promise<void>;
  save: () => Promise<string | null>;
  publish: () => ReturnType<AgentService['publish']>;
  linkAt: (environmentId: string) => Promise<string | null>;
}

async function authoring(owner: Organization = org): Promise<Authoring> {
  const { author } = owner;
  const agent = await service.create(author, { displayName: `Publish ${randomUUID().slice(0, 8)}` });
  const { chatId, templateDir } = await seedBuilderChat(author.tenantId, agent.id, author.userId);
  return {
    agentId: agent.id,
    templateDir,
    write: async (path, content = `${path}\n`) => {
      await mkdir(dirname(join(templateDir, path)), { recursive: true });
      await writeFile(join(templateDir, path), content);
    },
    save: async () => (await service.saveTemplate(author, agent.id, chatId)).hash,
    publish: () => service.publish(author, agent.id, { environmentId: owner.productionId }),
    linkAt: async (environmentId) => {
      try {
        return (await readlink(join(agentTemplatesDir(agent.id), environmentId))).split('/').pop() ?? null;
      } catch {
        return null;
      }
    },
  };
}

async function versionsOf(agentId: string): Promise<string[]> {
  return (await readdir(join(agentTemplatesDir(agentId), '.versions')).catch(() => [])).toSorted();
}

async function refusalCode(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  const response = (error as { getResponse?: () => unknown } | null)?.getResponse?.();
  return (response as { code?: string } | undefined)?.code ?? String(error);
}

async function productionPrompt(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ promptBody: agentProfiles.promptBody })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, org.productionId)));
  return row?.promptBody ?? null;
}

async function age(path: string, ms: number): Promise<void> {
  const at = new Date(Date.now() - ms);
  await utimes(path, at, at);
}

describe('publishing a Template (ADR-0073)', () => {
  it('points the target at the Development version, reporting Added', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();

    const published = await draft.publish();

    expect(published.applied.template).toBe('added');
    expect(await draft.linkAt(org.productionId)).toBe(hash);
    expect(await versionsOf(draft.agentId)).toEqual([hash]);
  });

  it('publishes a change to the Template alone and deletes the version nothing links to', async () => {
    const draft = await authoring();
    await draft.write('README.md', 'first\n');
    const first = await draft.save();
    await draft.publish();
    await draft.write('README.md', 'second\n');
    const second = await draft.save();
    expect(await versionsOf(draft.agentId)).toEqual([first, second].toSorted());

    const published = await draft.publish();

    expect(published.applied).toMatchObject({ prompt: 'same', model: null, template: 'changed' });
    expect(await draft.linkAt(org.productionId)).toBe(second);
    expect(await versionsOf(draft.agentId)).toEqual([second]);
  });

  it('reports Same once the target already has the Development version, and skips the no-op', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();
    await draft.publish();

    expect((await draft.publish()).applied.template).toBe('same');
  });

  it('removes the target Template when Development has none, reporting Removed', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();
    await draft.publish();
    await rm(draft.templateDir, { recursive: true, force: true });
    expect(await draft.save()).toBeNull();

    const published = await draft.publish();

    expect(published.applied.template).toBe('removed');
    expect(await draft.linkAt(org.productionId)).toBeNull();
    expect(await versionsOf(draft.agentId)).toEqual([]);
  });

  it('reports None when neither side has a Template', async () => {
    const draft = await authoring();
    expect((await draft.publish()).applied.template).toBe('none');
  });

  it('refuses a Development Template whose version is missing, asking for another save', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    await rm(join(agentTemplatesDir(draft.agentId), '.versions', hash ?? ''), { recursive: true });

    expect(await refusalCode(draft.publish())).toBe('template_damaged');
    expect(await productionPrompt(draft.agentId)).toBeNull();
  });

  it('rolls the Profile rows back when the link step fails', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();
    const blocker = join(agentTemplatesDir(draft.agentId), org.productionId);
    await mkdir(blocker, { recursive: true });
    await writeFile(join(blocker, 'occupied'), 'x');

    await expect(draft.publish()).rejects.toThrow();

    expect(await productionPrompt(draft.agentId)).toBeNull();
    await rm(blocker, { recursive: true });
  });

  it('fixes a target link left ahead of its rows on the next publish', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    await symlink(`.versions/${hash}`, join(agentTemplatesDir(draft.agentId), org.productionId));

    const published = await draft.publish();

    expect(published.applied).toMatchObject({ prompt: 'changed', template: 'same' });
    expect(await productionPrompt(draft.agentId)).toBe('');
    expect(await draft.linkAt(org.productionId)).toBe(hash);
  });
});

describe('Delete and Disable (Agent) and the Template', () => {
  it('removes every Template of a deleted Agent', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    await draft.save();

    await service.remove(org.author, draft.agentId, async (ids) => {
      await db.delete(projects).where(inArray(projects.id, ids));
    });

    expect(existsSync(agentTemplatesDir(draft.agentId))).toBe(false);
  });

  it('leaves the Templates of a disabled Agent alone', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    await draft.publish();

    await service.setDisabled(org.author, draft.agentId, true);

    expect(await draft.linkAt(org.developmentId)).toBe(hash);
    expect(await draft.linkAt(org.productionId)).toBe(hash);
    expect(await versionsOf(draft.agentId)).toEqual([hash]);
  });
});

describe('sweeping agent-templates/', () => {
  it('removes the folder of an Agent that no longer exists once it has settled', async () => {
    const settled = agentTemplatesDir(randomUUID());
    const fresh = agentTemplatesDir(randomUUID());
    for (const folder of [settled, fresh]) {
      await mkdir(join(folder, '.versions', 'abc'), { recursive: true });
      await writeFile(join(folder, '.versions', 'abc', 'README.md'), 'left over');
    }
    await age(settled, 2 * 60 * 60 * 1000);

    await runDailyCleanup();

    expect(existsSync(settled)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await rm(fresh, { recursive: true });
  });

  it('removes staging folders older than the retention and keeps recent ones', async () => {
    const draft = await authoring();
    const agentDir = agentTemplatesDir(draft.agentId);
    const stale = join(agentDir, '.staging-stale');
    const recent = join(agentDir, '.staging-recent');
    await mkdir(stale, { recursive: true });
    await mkdir(recent, { recursive: true });
    await age(stale, 8 * DAY_MS);

    await runDailyCleanup();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('removes versions no link points at and keeps the linked one', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    const unlinked = join(agentTemplatesDir(draft.agentId), '.versions', 'f'.repeat(64));
    await mkdir(unlinked, { recursive: true });

    await runDailyCleanup();

    expect(await versionsOf(draft.agentId)).toEqual([hash]);
  });

  it('skips an Agent whose lock is held until the next run', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    const unlinked = 'e'.repeat(64);
    await mkdir(join(agentTemplatesDir(draft.agentId), '.versions', unlinked), { recursive: true });

    await db.transaction(async (tx) => {
      await lockAgentTemplate(tx, draft.agentId);
      await runDailyCleanup();
    });
    expect(await versionsOf(draft.agentId)).toEqual([hash, unlinked].toSorted());

    await runDailyCleanup();
    expect(await versionsOf(draft.agentId)).toEqual([hash]);
  });

  it('leaves a link to a missing version in place', async () => {
    const draft = await authoring();
    await draft.write('README.md');
    const hash = await draft.save();
    await rm(join(agentTemplatesDir(draft.agentId), '.versions', hash ?? ''), { recursive: true });

    await runDailyCleanup();

    expect(await draft.linkAt(org.developmentId)).toBe(hash);
    expect((await lstat(join(agentTemplatesDir(draft.agentId), org.developmentId))).isSymbolicLink()).toBe(true);
  });
});

describe('the templates storage bucket', () => {
  it('attributes each Agent folder to its Organization and counts a shared version once', async () => {
    const owner = await organization();
    const content = 'x'.repeat(1000);
    const draft = await authoring(owner);
    await draft.write('brand.pdf', content);
    const hash = await draft.save();
    await draft.publish();
    const linkBytes = `.versions/${hash}`.length;

    const unowned = agentTemplatesDir(randomUUID());
    await mkdir(join(unowned, '.versions', 'abc'), { recursive: true });
    await writeFile(join(unowned, '.versions', 'abc', 'left'), 'y'.repeat(50));

    const view = await snapshots.build();

    const tenant = view.tenants.find((entry) => entry.id === owner.author.tenantId);
    expect(tenant?.templates).toEqual({ bytes: content.length + 2 * linkBytes, count: 1, error: false });
    expect(tenant?.totalBytes).toBeGreaterThanOrEqual(content.length + 2 * linkBytes);
    expect(view.buckets.templates.count).toBeGreaterThanOrEqual(1);
    expect(view.buckets.templates.bytes).toBeGreaterThanOrEqual(50);
    await rm(unowned, { recursive: true });
  });
});

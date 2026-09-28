import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'reflect-metadata';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  agentSettings,
  agents,
  environments,
  projects,
  skillVersions,
  skills,
} from '../../db/schema';
import { AgentController } from '../../src/agent/agent.controller';
import { BUILDER_AGENT_SLUG, liveBuiltInSlugs } from '../../src/agent/agent-visibility';
import { CUSTOM_AGENT_PACKAGE } from '../../src/delivery/delivery.types';
import { Perms } from '../../src/permission/permission.constants';
import { RELAXED_PERMISSION_KEY } from '../../src/permission/permission.guard';
import type { AgentCaller } from '../../src/agent/agent.types';
import type { AgentService } from '../../src/agent/agent.service';
import type { SkillCaller, SkillService } from '../../src/store/skill.service';
import { agentConfigRoot, packageSkillNames } from '../../src/store/skill-tree';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { defaultEnvironmentId, ensureBuiltInAgent, ensureBuiltInSkill, seedLiveAgent } from '../support/agent-fixtures';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from './support/skill-fixtures';

let harness: DomainTestHarness;
let service: AgentService;
let skillService: SkillService;

let tenantId: string;
let otherTenantId: string;
let author: AgentCaller;
let colleague: AgentCaller;
let skillAuthor: SkillCaller;
let developmentId: string;
let productionId: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  service = harness.agents;
  skillService = harness.skills;

  tenantId = await createTenantRow();
  otherTenantId = await createTenantRow();
  await harness.environments.ensureDefaultForTenant(tenantId);
  await harness.environments.ensureDefaultForTenant(otherTenantId);

  author = { tenantId, userId: await createUserRow(), canManageAgents: true };
  colleague = { tenantId, userId: await createUserRow(), canManageAgents: true };
  skillAuthor = { tenantId, userId: author.userId, canManageSkills: true };

  developmentId = await defaultEnvironmentId(tenantId);
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, false)))
    .limit(1);
  productionId = production.id;

  await ensureBuiltInSkill('platform');
});

afterAll(async () => {
  await harness.close();
});

function agentName(): string {
  return `Agent ${randomUUID().slice(0, 8)}`;
}

async function createSkill(caller: SkillCaller, name: string) {
  return skillService.create(caller, {
    name,
    files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`) }],
  });
}

function skillName(): string {
  return `skill-${randomUUID().slice(0, 8)}`;
}

async function code(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { code?: string })?.code ?? String(error);
  }
  throw new Error('the call was accepted');
}

describe('the AgentController permission surface', () => {
  const readRoutes = ['findAll', 'listStore', 'models', 'findOne', 'delivery'];

  it('carries a class-level @RequirePermission for can_manage_agents', () => {
    expect(Reflect.getMetadata('requiredPermission', AgentController)).toBe(Perms.manageAgents);
  });

  it('relaxes exactly the read routes', () => {
    const prototype = AgentController.prototype as unknown as Record<string, () => unknown>;
    const relaxed = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && Reflect.getMetadata(RELAXED_PERMISSION_KEY, prototype[name]) === true
    );
    expect(relaxed.toSorted()).toEqual(readRoutes.toSorted());
  });
});

describe('creating a custom agent', () => {
  it('derives a slug, defaults new projects to Production and lays down a Development profile with the platform skill', async () => {
    const created = await service.create(author, { displayName: 'My Research Agent', description: ' helper ' });

    expect(created).toMatchObject({
      name: 'my-research-agent',
      displayName: 'My Research Agent',
      description: 'helper',
      origin: 'custom',
      visibility: 'private',
      disabled: false,
      imageOwned: false,
      live: false,
      createdBy: author.userId,
      projectCount: 0,
    });
    expect(created.settings).toEqual({ defaultEnvironmentId: productionId, platformApi: false });

    const development = created.profiles.find((profile) => profile.environmentId === developmentId);
    expect(development).toMatchObject({ promptBody: '', model: 'openai/gpt-5.6-sol', variant: 'high' });
    expect(development?.skills?.map((skill) => skill.name)).toEqual(['platform']);

    const production = created.profiles.find((profile) => profile.environmentId === productionId);
    expect(production).toMatchObject({ promptBody: null, model: null, variant: null, skills: null });
  });

  it('refuses a taken slug and every merged-registry slug with the same code', async () => {
    const displayName = agentName();
    await service.create(author, { displayName });

    expect(await code(service.create(author, { displayName }))).toBe('name_unavailable');
    expect(await code(service.create(author, { displayName: 'app builder' }))).toBe('name_unavailable');
  });

  it('refuses an unknown provider, model and effort, naming the part', async () => {
    await expect(service.create(author, { displayName: agentName(), model: 'nope/gpt-5.6-sol' })).rejects.toMatchObject(
      { response: { code: 'model_unknown', part: 'provider', value: 'nope' } }
    );

    await expect(service.create(author, { displayName: agentName(), model: 'openai/nope' })).rejects.toMatchObject({
      response: { code: 'model_unknown', part: 'model', value: 'nope' },
    });

    await expect(
      service.create(author, { displayName: agentName(), model: 'openai/gpt-5.6-sol', variant: 'turbo' })
    ).rejects.toMatchObject({ response: { code: 'model_unknown', part: 'variant', value: 'turbo' } });
  });
});

describe('editing the Development profile', () => {
  it('writes the prompt and the model pair onto the Development row only', async () => {
    const created = await service.create(author, { displayName: agentName() });

    const updated = await service.updateProfile(author, created.id, {
      promptBody: 'Answer briefly.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
    });

    const development = updated.profiles.find((profile) => profile.environmentId === developmentId);
    expect(development).toMatchObject({ promptBody: 'Answer briefly.', variant: 'low' });
    expect(updated.profiles.find((profile) => profile.environmentId === productionId)?.skills).toBeNull();
  });

  it('refuses a built-in agent', async () => {
    const builtIn = await ensureBuiltInAgent('app-builder');

    expect(await code(service.updateProfile(author, builtIn, { promptBody: 'x', model: 'openai/gpt-5.6-sol' }))).toBe(
      'not_publishable'
    );
  });
});

describe('agent skills', () => {
  it('adds at the latest version, re-pins within the same skill and refuses a foreign version', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const name = skillName();
    const skill = await createSkill(skillAuthor, name);
    const other = await createSkill(skillAuthor, skillName());

    const added = await service.setSkill(author, agent.id, skill.id, {});
    expect(added.map((row) => row.name).toSorted()).toEqual(['platform', name].toSorted());
    expect(added.find((row) => row.name === name)).toMatchObject({ pinnedVersion: 1, updateAvailable: false });

    await skillService.addVersion(skillAuthor, skill.id, {
      files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, '# Two\n') }],
    });
    const stale = await service.listSkills(author, agent.id);
    expect(stale.find((row) => row.name === name)).toMatchObject({
      pinnedVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
    });

    const otherVersion = (await skillService.listVersions(skillAuthor, other.id))[0];
    expect(await code(service.setSkill(author, agent.id, skill.id, { versionId: otherVersion.contentHash }))).toContain(
      'NotFoundException'
    );
  });

  /** The Store UI's Undo after Remove: it re-adds with the `pinnedVersionId` the row reported. */
  it('reports the pinned version row so a removed skill can be re-added at the same version', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const name = skillName();
    const skill = await createSkill(skillAuthor, name);
    await service.setSkill(author, agent.id, skill.id, {});
    await skillService.addVersion(skillAuthor, skill.id, {
      files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, '# Two\n') }],
    });

    const pinned = (await service.listSkills(author, agent.id)).find((row) => row.name === name);
    assert(pinned, `the Agent does not carry the Skill ${name}`);
    expect(pinned).toMatchObject({ pinnedVersion: 1, latestVersion: 2 });
    expect(pinned.pinnedVersionId).toEqual(expect.any(String));

    const afterRemove = await service.removeSkill(author, agent.id, skill.id);
    expect(afterRemove.map((row) => row.name)).not.toContain(name);

    const undone = await service.setSkill(author, agent.id, skill.id, { versionId: pinned.pinnedVersionId });
    expect(undone.find((row) => row.name === name)).toMatchObject({
      pinnedVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
    });

    const upgraded = await service.setSkill(author, agent.id, skill.id, {});
    expect(upgraded.find((row) => row.name === name)).toMatchObject({ pinnedVersion: 2, updateAvailable: false });
  });

  it('refuses a private skill on a public agent and refuses removing platform', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const secret = await createSkill(skillAuthor, skillName());
    const shared = await createSkill(skillAuthor, skillName());
    await skillService.setVisibility(skillAuthor, shared.id, { visibility: 'public' });

    await service.setSkill(author, agent.id, shared.id, {});
    await service.setVisibility(author, agent.id, { visibility: 'public' });

    expect(await code(service.setSkill(author, agent.id, secret.id, {}))).toBe('visibility_incoherent');

    const platform = (await service.listSkills(author, agent.id)).find((row) => row.name === 'platform');
    expect(await code(service.removeSkill(author, agent.id, platform?.skillId ?? ''))).toBe('not_editable');
  });

  it('parks one profile per organization on a built-in agent and refuses publishing it', async () => {
    const builtIn = await ensureBuiltInAgent('app-builder');
    const mine = await createSkill(skillAuthor, skillName());
    await skillService.setVisibility(skillAuthor, mine.id, { visibility: 'public' });

    await service.setSkill(author, builtIn, mine.id, {});
    const parked = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, builtIn), eq(agentProfiles.environmentId, developmentId)));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ promptBody: null, model: null, variant: null });

    const stranger: AgentCaller = { tenantId: otherTenantId, userId: await createUserRow(), canManageAgents: true };
    const theirSkill = await createSkill({ ...stranger, canManageSkills: true }, skillName());
    await skillService.setVisibility({ ...stranger, canManageSkills: true }, theirSkill.id, { visibility: 'public' });
    await service.setSkill(stranger, builtIn, theirSkill.id, {});

    const all = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .innerJoin(environments, eq(environments.id, agentProfiles.environmentId))
      .where(and(eq(agentProfiles.agentId, builtIn), inArray(environments.tenantId, [tenantId, otherTenantId])));
    expect(all).toHaveLength(2);

    const seen = await service.findOne(author, builtIn);
    expect(seen.profiles.map((profile) => profile.environmentId)).toEqual([developmentId]);
    expect(seen.profiles[0]?.skills?.map((skill) => skill.name)).not.toContain(theirSkill.name);
    expect(seen).toMatchObject({ imageOwned: true });

    expect(await code(service.publish(author, builtIn, { environmentId: productionId }))).toBe('not_publishable');
  });
});

function agentConfigDirectories(...segments: string[]): string[] {
  const directory = join(agentConfigRoot(), ...segments);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('the Skills a Built-in Agent ships', () => {
  const composer = import(pathToFileURL(join(agentConfigRoot(), 'scripts', 'compose-skills.mjs')).href) as Promise<{
    sharedSkillsForPackage: (packageName: string, sharedNames: string[]) => string[];
    planCompose: (sharedNames: string[], overrideNames: string[]) => { name: string }[];
  }>;

  async function shippedNames(packageName: string): Promise<string[]> {
    const detail = await service.findOne(author, await ensureBuiltInAgent(packageName));
    return detail.shippedSkills.map((skill) => skill.name);
  }

  it('leaves web-app and dates out of Makara, which carries its own', async () => {
    const makara = await shippedNames('makara-app-builder');

    expect(makara).not.toContain('web-app');
    expect(makara).not.toContain('dates');
    expect(makara).toContain('makara-dates');
    expect(makara).toContain('platform');
  });

  it('keeps the whole shared pool on App Builder', async () => {
    const appBuilder = await shippedNames('app-builder');

    expect(appBuilder).toContain('web-app');
    expect(appBuilder).toContain('dates');
    expect(appBuilder).toContain('ui');
  });

  it('matches what the image composer lays into every package', async () => {
    const { planCompose, sharedSkillsForPackage } = await composer;
    const packages = [
      ...agentConfigDirectories('agents'),
      ...agentConfigDirectories('private', 'agents'),
      CUSTOM_AGENT_PACKAGE,
    ];

    for (const packageName of new Set(packages)) {
      const own = [
        ...agentConfigDirectories('agents', packageName, 'skills'),
        ...agentConfigDirectories('private', 'agents', packageName, 'skills'),
      ];
      const composed = planCompose(sharedSkillsForPackage(packageName, agentConfigDirectories('skills')), own).map(
        (skill) => skill.name
      );
      expect([...packageSkillNames(packageName)].toSorted(), packageName).toEqual(composed.toSorted());
    }
  });
});

describe('publishing an agent to another environment', () => {
  it('copies rows rather than a blob and reports the diff', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const extra = await createSkill(skillAuthor, skillName());
    await service.setSkill(author, agent.id, extra.id, {});
    await service.updateProfile(author, agent.id, {
      promptBody: 'Be terse.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
    });

    const first = await service.publish(author, agent.id, { environmentId: productionId });
    expect(first.applied.prompt).toBe('changed');
    expect(first.applied.skills.added.toSorted()).toEqual(['platform', extra.name].toSorted());
    expect(first.applied.skills.removed).toEqual([]);

    const [target] = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, productionId)));
    const targetRows = await db
      .select({ skillId: agentProfileSkills.skillId, versionId: agentProfileSkills.skillVersionId })
      .from(agentProfileSkills)
      .where(eq(agentProfileSkills.profileId, target.id));
    const [development] = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, developmentId)));
    const developmentRows = await db
      .select({ skillId: agentProfileSkills.skillId, versionId: agentProfileSkills.skillVersionId })
      .from(agentProfileSkills)
      .where(eq(agentProfileSkills.profileId, development.id));

    expect(target).toMatchObject({ promptBody: 'Be terse.', model: 'openai/gpt-5.6-sol', variant: 'low' });
    expect(targetRows.toSorted((a, b) => a.skillId.localeCompare(b.skillId))).toEqual(
      developmentRows.toSorted((a, b) => a.skillId.localeCompare(b.skillId))
    );

    const beforeSecond = await db
      .select({ addedAt: agentProfileSkills.addedAt })
      .from(agentProfileSkills)
      .where(eq(agentProfileSkills.profileId, target.id))
      .orderBy(agentProfileSkills.skillId);

    const second = await service.publish(author, agent.id, { environmentId: productionId });
    expect(second.applied).toEqual({
      prompt: 'same',
      model: null,
      skills: { added: [], removed: [], repinned: [] },
      template: 'none',
    });

    const [untouched] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, target.id));
    const afterSecond = await db
      .select({ addedAt: agentProfileSkills.addedAt })
      .from(agentProfileSkills)
      .where(eq(agentProfileSkills.profileId, target.id))
      .orderBy(agentProfileSkills.skillId);
    expect(untouched.updatedAt).toEqual(target.updatedAt);
    expect(afterSecond).toEqual(beforeSecond);
  });

  it('refuses an environment outside the organization', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const foreign = await defaultEnvironmentId(otherTenantId);

    expect(await code(service.publish(author, agent.id, { environmentId: foreign }))).toContain('NotFoundException');
  });
});

describe('picker liveness', () => {
  it('never offers the builder slug', () => {
    expect(liveBuiltInSlugs()).not.toContain(BUILDER_AGENT_SLUG);
  });

  it('offers exactly the live rows and keeps resolving the rest by id', async () => {
    const registryBuiltIn = await ensureBuiltInAgent('app-builder');
    const retired = await ensureBuiltInAgent(`retired-${randomUUID().slice(0, 8)}`);
    const builder = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
    const live = await seedLiveAgent(tenantId, author.userId);
    const profileless = await seedLiveAgent(tenantId, author.userId, { withProfile: false });
    const disabled = await seedLiveAgent(tenantId, author.userId, { disabled: true });

    const offered = new Set((await service.findAll(author)).map((row) => row.id));

    expect(offered.has(registryBuiltIn)).toBe(true);
    expect(offered.has(live.id)).toBe(true);
    expect(offered.has(retired)).toBe(false);
    expect(offered.has(builder)).toBe(false);
    expect(offered.has(profileless.id)).toBe(false);
    expect(offered.has(disabled.id)).toBe(false);

    for (const id of [retired, builder, profileless.id, disabled.id]) {
      expect((await service.findById(id)).id).toBe(id);
    }
  });

  it('hides another member private custom agent from the picker', async () => {
    const mine = await seedLiveAgent(tenantId, author.userId, { visibility: 'private' });

    const offered = new Set((await service.findAll(colleague)).map((row) => row.id));

    expect(offered.has(mine.id)).toBe(false);
  });

  it('refuses a project created on an agent that is not live', async () => {
    const disabled = await seedLiveAgent(tenantId, author.userId, { disabled: true });

    await expect(service.assertLiveForProjectCreate(disabled.id, tenantId, author.userId)).rejects.toThrow(
      `Agent ${disabled.id} not found`
    );
  });

  it('lists disabled rows under the Disabled chip with live computed', async () => {
    const disabled = await seedLiveAgent(tenantId, author.userId, { disabled: true });

    const store = await service.listStore(author, 'disabled');
    const row = store.find((entry) => entry.id === disabled.id);

    expect(row).toMatchObject({ disabled: true, live: false });
    expect((await service.listStore({ ...colleague, canManageAgents: false })).some((e) => e.id === disabled.id)).toBe(
      false
    );
  });
});

describe('the store agent list filters', () => {
  it('narrows to the chip the caller picked and to the search term', async () => {
    const mine = await seedLiveAgent(tenantId, author.userId, { visibility: 'private' });
    const builtIn = await ensureBuiltInAgent('app-builder');

    const custom = await service.listStore(author, 'custom');
    const priv = await service.listStore(author, 'private');
    const searched = await service.listStore(author, 'all', mine.description);

    expect(custom.some((row) => row.id === mine.id)).toBe(true);
    expect(custom.some((row) => row.id === builtIn)).toBe(false);
    expect(priv.every((row) => row.visibility === 'private')).toBe(true);
    expect(searched.map((row) => row.id)).toEqual([mine.id]);
  });

  it('keeps disabled rows out of every chip but Disabled', async () => {
    const disabled = await seedLiveAgent(tenantId, author.userId, { disabled: true });

    for (const filter of ['all', 'built_in', 'custom', 'private'] as const) {
      expect((await service.listStore(author, filter)).some((row) => row.id === disabled.id)).toBe(false);
    }
    expect((await service.listStore(author, 'disabled')).some((row) => row.id === disabled.id)).toBe(true);
  });

  it('refuses the Disabled chip and an unknown chip', async () => {
    await expect(service.listStore({ ...author, canManageAgents: false }, 'disabled')).rejects.toThrow(
      /can_manage_agents/
    );
    expect(await code(service.listStore(author, 'nonsense'))).toBe('bad_request');
  });

  it('carries the environments holding a profile and the default one', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    await service.publish(author, agent.id, { environmentId: productionId });

    const row = (await service.listStore(author)).find((entry) => entry.id === agent.id);

    expect(row?.defaultEnvironmentId).toBe(productionId);
    expect(row?.profileEnvironmentIds.toSorted()).toEqual([developmentId, productionId].toSorted());
  });
});

describe('agent lifecycle', () => {
  it('duplicates the Development profile into a fresh private agent', async () => {
    const source = await service.create(author, { displayName: agentName() });
    const extra = await createSkill(skillAuthor, skillName());
    await service.setSkill(author, source.id, extra.id, {});
    await service.updateProfile(author, source.id, {
      promptBody: 'Copy me.',
      model: 'openai/gpt-5.6-sol',
      variant: 'low',
    });

    const copy = await service.duplicate(author, source.id, { displayName: agentName() });

    const development = copy.profiles.find((profile) => profile.environmentId === developmentId);
    expect(copy).toMatchObject({ visibility: 'private', origin: 'custom' });
    expect(development).toMatchObject({ promptBody: 'Copy me.', variant: 'low' });
    expect(development?.skills?.map((row) => row.name).toSorted()).toEqual(['platform', extra.name].toSorted());
  });

  it('deletes a never-published agent outright and hands its test projects over for removal', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const testProjectId = await seedProject(agent.id, 'test');
    const removed: string[][] = [];

    await service.remove(author, agent.id, async (ids) => {
      removed.push(ids);
      await db.delete(projects).where(inArray(projects.id, ids));
    });

    expect(removed).toEqual([[testProjectId]]);
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id));
    expect(rows).toHaveLength(0);
  });

  it('asks for an agent published beyond Development to be disabled first', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    await service.publish(author, agent.id, { environmentId: productionId });

    expect(await code(service.remove(author, agent.id, noTestProjects))).toBe('agent_not_disabled');

    await service.setDisabled(author, agent.id, true);
    await service.remove(author, agent.id, noTestProjects);
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id))).toHaveLength(0);
  });

  it('refuses while an ordinary project runs on the agent and counts no test project', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    await seedProject(agent.id, 'test');
    expect((await service.findOne(author, agent.id)).projectCount).toBe(0);

    await seedProject(agent.id, null);

    expect((await service.findOne(author, agent.id)).projectCount).toBe(1);
    expect(await code(service.remove(author, agent.id, noTestProjects))).toBe('agent_in_use');
  });

  it('points new projects at another environment through settings', async () => {
    const agent = await service.create(author, { displayName: agentName() });

    const updated = await service.updateSettings(author, agent.id, {
      defaultEnvironmentId: productionId,
      platformApi: true,
    });

    expect(updated.settings).toEqual({ defaultEnvironmentId: productionId, platformApi: true });
    const foreign = await defaultEnvironmentId(otherTenantId);
    expect(await code(service.updateSettings(author, agent.id, { defaultEnvironmentId: foreign }))).toContain(
      'NotFoundException'
    );
  });

  it('refuses Development as the default environment and still takes any other', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const staging = await harness.environments.create(tenantId, { name: `Staging ${randomUUID().slice(0, 6)}` });

    expect(await code(service.updateSettings(author, agent.id, { defaultEnvironmentId: developmentId }))).toBe(
      'development_not_default'
    );
    expect((await service.findOne(author, agent.id)).settings.defaultEnvironmentId).toBe(productionId);

    const moved = await service.updateSettings(author, agent.id, { defaultEnvironmentId: staging.id });
    expect(moved.settings.defaultEnvironmentId).toBe(staging.id);
  });

  it('leaves an existing agent on a Development default as it is', async () => {
    const agent = await seedLiveAgent(tenantId, author.userId);

    const kept = await service.updateSettings(author, agent.id, { platformApi: true });

    expect(kept).toMatchObject({ live: true, settings: { defaultEnvironmentId: developmentId, platformApi: true } });
  });
});

describe('deleting an environment an agent holds', () => {
  it('refuses while a profile or a default-environment setting points at it', async () => {
    const environment = await harness.environments.create(tenantId, { name: `Staging ${randomUUID().slice(0, 6)}` });
    const agent = await service.create(author, { displayName: agentName() });
    await service.publish(author, agent.id, { environmentId: environment.id });

    expect(await code(harness.environments.remove(tenantId, environment.id))).toBe('environment_in_use');

    await db
      .delete(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, environment.id)));
    await db
      .update(agentSettings)
      .set({ defaultEnvironmentId: environment.id })
      .where(eq(agentSettings.agentId, agent.id));

    expect(await code(harness.environments.remove(tenantId, environment.id))).toBe('environment_in_use');

    await db
      .update(agentSettings)
      .set({ defaultEnvironmentId: developmentId })
      .where(eq(agentSettings.agentId, agent.id));
    await harness.environments.remove(tenantId, environment.id);
  });
});

describe('identity and visibility', () => {
  it('renames and re-describes an agent, and refuses an empty display name', async () => {
    const agent = await service.create(author, { displayName: agentName(), description: 'first' });

    const renamed = await service.update(author, agent.id, { displayName: 'Renamed Agent', description: '  next  ' });

    expect(renamed).toMatchObject({ displayName: 'Renamed Agent', description: 'next', name: agent.name });
    expect((await service.update(author, agent.id, { description: null })).description).toBeNull();
    expect(await code(service.update(author, agent.id, { displayName: '   ' }))).toBe('bad_request');
  });

  it('widens visibility once and refuses the way back', async () => {
    const agent = await service.create(author, { displayName: agentName() });

    expect((await service.setVisibility(author, agent.id, { visibility: 'public' })).visibility).toBe('public');
    expect(await code(service.setVisibility(author, agent.id, { visibility: 'private' }))).toBe(
      'visibility_incoherent'
    );
  });

  it('withdraws a disabled agent from the picker and enables it again', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    await service.publish(author, agent.id, { environmentId: productionId });
    const offered = async () => new Set((await service.findAll(author)).map((row) => row.id));

    expect((await offered()).has(agent.id)).toBe(true);

    expect((await service.setDisabled(author, agent.id, true)).disabled).toBe(true);
    expect((await offered()).has(agent.id)).toBe(false);

    expect((await service.setDisabled(author, agent.id, false)).disabled).toBe(false);
    expect((await offered()).has(agent.id)).toBe(true);
  });
});

describe('the guards a caller cannot reach through the API', () => {
  it('refuses a disabled skill', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const skill = await createSkill(skillAuthor, skillName());
    await skillService.setDisabled(skillAuthor, skill.id, true);

    expect(await code(service.setSkill(author, agent.id, skill.id, {}))).toBe('skill_disabled');
  });

  it('refuses a second skill carrying a name the profile already has', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const name = skillName();
    const shipped = await ensureBuiltInSkill(name);
    await service.setSkill(author, agent.id, shipped.skillId, {});

    const shadowId = randomUUID();
    const shadowVersionId = randomUUID();
    await db
      .insert(skills)
      .values({ id: shadowId, tenantId, name, origin: 'custom', visibility: 'public', createdBy: author.userId });
    await db
      .insert(skillVersions)
      .values({ id: shadowVersionId, skillId: shadowId, version: 1, contentHash: name, createdVia: 'form' });
    await db.update(skills).set({ latestVersionId: shadowVersionId }).where(eq(skills.id, shadowId));

    expect(await code(service.setSkill(author, agent.id, shadowId, {}))).toBe('duplicate_skill_name');
  });

  it('refuses a publish once a public agent is carrying a private skill', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const secret = await createSkill(skillAuthor, skillName());
    await service.setSkill(author, agent.id, secret.id, {});

    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, agent.id));

    expect(await code(service.publish(author, agent.id, { environmentId: productionId }))).toBe(
      'visibility_incoherent'
    );
  });
});

describe('the delivery view', () => {
  /** A Custom Agent's Projects are frozen snapshots, so there is nothing for them to converge on. */
  it('is empty for a Custom Agent', async () => {
    const agent = await service.create(author, { displayName: agentName() });

    expect(await service.delivery(author, agent.id)).toEqual({
      environments: [],
      summary: { total: 0, converged: 0 },
    });
  });
});

const noTestProjects = async () => {};

async function seedProject(agentId: string, kind: 'test' | null): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({ id, tenantId, agentId, kind, title: `project-${id}` });
  return id;
}

describe('disabling a built-in agent for one Organization (ADR-0072)', () => {
  async function freshOrganization(): Promise<AgentCaller> {
    const id = await createTenantRow();
    await harness.environments.ensureDefaultForTenant(id);
    return { tenantId: id, userId: await createUserRow(), canManageAgents: true };
  }

  it('takes it out of that Organization only, and back on enable', async () => {
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const here = await freshOrganization();
    const elsewhere = await freshOrganization();

    const disabled = await service.setDisabled(here, makara, true);

    expect(disabled.disabled).toBe(true);
    expect((await service.findAll(here)).map((agent) => agent.id)).not.toContain(makara);
    expect((await service.findAll(elsewhere)).map((agent) => agent.id)).toContain(makara);
    expect((await service.findOne(elsewhere, makara)).disabled).toBe(false);

    await service.setDisabled(here, makara, false);
    expect((await service.findAll(here)).map((agent) => agent.id)).toContain(makara);
  });

  it('closes it to new projects there, and resolves an import by its name to nothing', async () => {
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();
    await service.setDisabled(caller, makara, true);

    await expect(service.assertLiveForProjectCreate(makara, caller.tenantId, caller.userId)).rejects.toThrow();
    expect(await service.findIdByName('makara-app-builder', caller.tenantId)).toBeNull();
    expect(await service.findIdByName('makara-app-builder', otherTenantId)).toBe(makara);
  });

  it('refuses to disable the last built-in agent an Organization can start a project on, the Builder aside', async () => {
    await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
    const appBuilder = await ensureBuiltInAgent('app-builder');
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();

    await service.setDisabled(caller, makara, true);

    expect(await code(service.setDisabled(caller, appBuilder, true))).toBe('last_built_in_agent');

    await service.setDisabled(caller, makara, false);
    await expect(service.setDisabled(caller, appBuilder, true)).resolves.toMatchObject({ disabled: true });
  });

  it('lets only one of two concurrent disables of the last two built-in agents through', async () => {
    const appBuilder = await ensureBuiltInAgent('app-builder');
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();

    const outcomes = await Promise.allSettled([
      service.setDisabled(caller, appBuilder, true),
      service.setDisabled(caller, makara, true),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await service.findAll(caller)).some((agent) => agent.id === appBuilder || agent.id === makara)).toBe(true);
  });

  it('starts a project that names no agent on the first built-in agent still enabled', async () => {
    const appBuilder = await ensureBuiltInAgent('app-builder');
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();

    expect(await service.getDefaultAgentId(caller.tenantId)).toBe(appBuilder);

    await service.setDisabled(caller, appBuilder, true);

    expect(await service.getDefaultAgentId(caller.tenantId)).toBe(makara);
    expect(await service.getDefaultAgentId(otherTenantId)).toBe(appBuilder);
  });

  it('never disables the Skill & Agent Builder, says so up front, and asks for can_manage_agents', async () => {
    const builder = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();

    expect((await service.findOne(caller, builder)).disableable).toBe(false);
    expect((await service.findOne(caller, makara)).disableable).toBe(true);
    expect(await code(service.setDisabled(caller, builder, true))).toBe('not_disableable');
    await expect(service.setDisabled({ ...caller, canManageAgents: false }, makara, true)).rejects.toThrow(
      Perms.manageAgents
    );
  });

  it('lists it under the disabled filter and nowhere else', async () => {
    const makara = await ensureBuiltInAgent('makara-app-builder');
    const caller = await freshOrganization();
    await service.setDisabled(caller, makara, true);

    expect((await service.listStore(caller, 'disabled')).map((agent) => agent.id)).toContain(makara);
    expect((await service.listStore(caller, 'built_in')).map((agent) => agent.id)).not.toContain(makara);
  });

  it("reports the skills a built-in agent's package ships", async () => {
    const appBuilder = await ensureBuiltInAgent('app-builder');

    const detail = await service.findOne(author, appBuilder);

    expect(detail.shippedSkills.map((skill) => skill.name)).toContain('platform');
  });
});

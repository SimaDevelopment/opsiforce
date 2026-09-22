import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  agentSettings,
  agents,
  environments,
  skillVersions,
  skills,
} from '../../db/schema';
import { AgentController } from '../../src/agent/agent.controller';
import { BUILDER_AGENT_SLUG, liveBuiltInSlugs } from '../../src/agent/agent-visibility';
import { Perms } from '../../src/permission/permission.constants';
import { RELAXED_PERMISSION_KEY } from '../../src/permission/permission.guard';
import type { AgentCaller } from '../../src/agent/agent.types';
import type { AgentService } from '../../src/agent/agent.service';
import type { SkillCaller, SkillService } from '../../src/store/skill.service';
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
  const readRoutes = ['findAll', 'listStore', 'models', 'findOne', 'listSkills', 'delivery'];

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
  it('derives a slug and lays down settings, a Development profile and the platform skill', async () => {
    const created = await service.create(author, { displayName: 'My Research Agent', description: ' helper ' });

    expect(created).toMatchObject({
      name: 'my-research-agent',
      displayName: 'My Research Agent',
      description: 'helper',
      origin: 'custom',
      visibility: 'private',
      archived: false,
      imageOwned: false,
      live: true,
      createdBy: author.userId,
      projectCount: 0,
    });
    expect(created.settings).toEqual({ defaultEnvironmentId: developmentId, platformApi: false });

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

    const all = await db.select().from(agentProfiles).where(eq(agentProfiles.agentId, builtIn));
    expect(all).toHaveLength(2);

    const seen = await service.findOne(author, builtIn);
    expect(seen.profiles.map((profile) => profile.environmentId)).toEqual([developmentId]);
    expect(seen.profiles[0]?.skills?.map((skill) => skill.name)).not.toContain(theirSkill.name);
    expect(seen).toMatchObject({ imageOwned: true });

    expect(await code(service.publish(author, builtIn, { environmentId: productionId }))).toBe('not_publishable');
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
    const archived = await seedLiveAgent(tenantId, author.userId, { archived: true });

    const offered = new Set((await service.findAll(author)).map((row) => row.id));

    expect(offered.has(registryBuiltIn)).toBe(true);
    expect(offered.has(live.id)).toBe(true);
    expect(offered.has(retired)).toBe(false);
    expect(offered.has(builder)).toBe(false);
    expect(offered.has(profileless.id)).toBe(false);
    expect(offered.has(archived.id)).toBe(false);

    for (const id of [retired, builder, profileless.id, archived.id]) {
      expect((await service.findById(id)).id).toBe(id);
    }
  });

  it('hides another member private custom agent from the picker', async () => {
    const mine = await seedLiveAgent(tenantId, author.userId, { visibility: 'private' });

    const offered = new Set((await service.findAll(colleague)).map((row) => row.id));

    expect(offered.has(mine.id)).toBe(false);
  });

  it('refuses a project created on an agent that is not live', async () => {
    const archived = await seedLiveAgent(tenantId, author.userId, { archived: true });

    await expect(service.assertLiveForProjectCreate(archived.id, tenantId, author.userId)).rejects.toThrow(
      `Agent ${archived.id} not found`
    );
  });

  it('lists archived rows under the Archived chip with live computed', async () => {
    const archived = await seedLiveAgent(tenantId, author.userId, { archived: true });

    const store = await service.listStore(author, 'archived');
    const row = store.find((entry) => entry.id === archived.id);

    expect(row).toMatchObject({ archived: true, live: false });
    expect((await service.listStore({ ...colleague, canManageAgents: false })).some((e) => e.id === archived.id)).toBe(
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

  it('keeps archived rows out of every chip but Archived', async () => {
    const archived = await seedLiveAgent(tenantId, author.userId, { archived: true });

    for (const filter of ['all', 'built_in', 'custom', 'private'] as const) {
      expect((await service.listStore(author, filter)).some((row) => row.id === archived.id)).toBe(false);
    }
    expect((await service.listStore(author, 'archived')).some((row) => row.id === archived.id)).toBe(true);
  });

  it('refuses the Archived chip and an unknown chip', async () => {
    await expect(service.listStore({ ...author, canManageAgents: false }, 'archived')).rejects.toThrow(
      /can_manage_agents/
    );
    expect(await code(service.listStore(author, 'nonsense'))).toBe('bad_request');
  });

  it('carries the environments holding a profile and the default one', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    await service.publish(author, agent.id, { environmentId: productionId });

    const row = (await service.listStore(author)).find((entry) => entry.id === agent.id);

    expect(row?.defaultEnvironmentId).toBe(developmentId);
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

  it('starts a duplicate of a built-in agent from an empty prompt and the registry model', async () => {
    const builtIn = await ensureBuiltInAgent('app-builder');

    const copy = await service.duplicate(author, builtIn, { displayName: agentName() });

    const development = copy.profiles.find((profile) => profile.environmentId === developmentId);
    expect(development).toMatchObject({ promptBody: '', model: 'openai/gpt-5.6-sol', variant: 'high' });
  });

  it('deletes only an archived agent with no projects', async () => {
    const agent = await service.create(author, { displayName: agentName() });

    expect(await code(service.remove(author, agent.id))).toBe('agent_not_archived');

    await service.setArchived(author, agent.id, true);
    await service.remove(author, agent.id);

    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id));
    expect(rows).toHaveLength(0);
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

  it('withdraws an archived agent from the picker and restores it', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const offered = async () => new Set((await service.findAll(author)).map((row) => row.id));

    expect((await offered()).has(agent.id)).toBe(true);

    expect((await service.setArchived(author, agent.id, true)).archived).toBe(true);
    expect((await offered()).has(agent.id)).toBe(false);

    expect((await service.setArchived(author, agent.id, false)).archived).toBe(false);
    expect((await offered()).has(agent.id)).toBe(true);
  });
});

describe('the guards a caller cannot reach through the API', () => {
  it('refuses an archived skill', async () => {
    const agent = await service.create(author, { displayName: agentName() });
    const skill = await createSkill(skillAuthor, skillName());
    await skillService.setArchived(skillAuthor, skill.id, true);

    expect(await code(service.setSkill(author, agent.id, skill.id, {}))).toBe('skill_archived');
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

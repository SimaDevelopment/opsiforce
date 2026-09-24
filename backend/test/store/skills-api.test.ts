import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  agentProfiles,
  agentProfileSkills,
  agents,
  environments,
  projectEnvironments,
  projects,
  projectSkillDeliveryState,
  skills,
  skillVersions,
  users,
} from '../../db/schema';
import { RELAXED_PERMISSION_KEY } from '../../src/permission/permission.guard';
import { Perms } from '../../src/permission/permission.constants';
import { unpackSkill } from '../../src/store/gate';
import { reservedSkillNames } from '../../src/store/skill-reconciler.service';
import { SkillsController } from '../../src/store/skills.controller';
import type { ProjectKind } from '../../src/project/project.types';
import type { SkillCaller, SkillService } from '../../src/store/skill.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { manifest, validDescription } from './support/skill-fixtures';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { ensureBuiltInSkill } from '../support/agent-fixtures';

let harness: DomainTestHarness;
let service: SkillService;

let tenantId: string;
let otherTenantId: string;
let author: SkillCaller;
let colleague: SkillCaller;
let outsider: SkillCaller;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  service = harness.skills;

  tenantId = await createTenantRow();
  otherTenantId = await createTenantRow();
  author = await createCaller(tenantId);
  colleague = await createCaller(tenantId);
  outsider = await createCaller(otherTenantId);
});

afterAll(async () => {
  await harness.close();
});

async function createCaller(tenant: string): Promise<SkillCaller> {
  return { tenantId: tenant, userId: await createUserRow(), canManageSkills: true };
}

function skillName(): string {
  return `skill-${randomUUID().slice(0, 8)}`;
}

function files(name: string, body = '# Body\n') {
  return [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, body) }];
}

async function noProjects(): Promise<void> {}

async function anyAgentId(): Promise<string> {
  const [row] = await db.select({ id: agents.id }).from(agents).limit(1);
  return row.id;
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

async function message(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { message?: string })?.message ?? String(error);
  }
  throw new Error('the call was accepted');
}

describe('the SkillsController permission surface', () => {
  const readRoutes = ['list', 'findOne', 'listAgents', 'listVersions', 'listFiles', 'export'];

  it('carries a class-level @RequirePermission for can_manage_skills', () => {
    expect(Reflect.getMetadata('requiredPermission', SkillsController)).toBe(Perms.manageSkills);
  });

  it('relaxes exactly the read routes', () => {
    const prototype = SkillsController.prototype as unknown as Record<string, () => unknown>;
    const relaxed = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && Reflect.getMetadata(RELAXED_PERMISSION_KEY, prototype[name]) === true
    );
    expect(relaxed.toSorted()).toEqual(readRoutes.toSorted());
  });
});

describe('creating a skill', () => {
  it('stores version 1, the denormalized description and private visibility', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });

    expect(created).toMatchObject({
      name,
      origin: 'custom',
      visibility: 'private',
      disabled: false,
      available: true,
      usedByAgentCount: 0,
      createdBy: author.userId,
    });
    expect(created.latestVersion).toMatchObject({ version: 1 });
    expect(created.description).toBe(validDescription);
  });

  it('refuses a taken name, a reserved name and an image skill name with the same message', async () => {
    const taken = skillName();
    await service.create(author, { name: taken, files: files(taken) });
    const imageSkill = [...reservedSkillNames()].find((candidate) => candidate !== 'platform');

    const takenMessage = await message(service.create(author, { name: taken, files: files(taken) }));
    const reservedMessage = await message(service.create(author, { name: 'platform', files: files('platform') }));

    expect(takenMessage).toBe(`The name \`${taken}\` is unavailable`);
    expect(reservedMessage).toBe('The name `platform` is unavailable');
    expect(await code(service.create(author, { name: 'platform', files: files('platform') }))).toBe('name_unavailable');

    if (imageSkill) {
      expect(await code(service.create(author, { name: imageSkill, files: files(imageSkill) }))).toBe(
        'name_unavailable'
      );
    }
  });

  it('returns every error and lint and writes nothing when the gate fails', async () => {
    const name = skillName();
    const gateFailure = service.create(author, {
      name,
      files: [{ path: 'SKILL.md', content: manifest('name: WRONG\ndescription: short') }],
    });

    expect(await code(gateFailure)).toBe('validation_failed');
    const rows = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
    expect(rows).toHaveLength(0);
  });

  it('runs the gate without writing on validate', async () => {
    const name = skillName();
    const result = service.validate({ name, files: [{ path: 'SKILL.md', content: manifest('name: other') }] });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.rule)).toContain('name_mismatch');
    expect(await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name))).toHaveLength(0);
  });
});

describe('a private skill', () => {
  it('is readable and editable by its creator only, until it is made public', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });

    await expect(service.findOne(author, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(service.findOne(colleague, created.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(colleague, created.id, { displayName: 'Nope' })).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(service.findOne(outsider, created.id)).rejects.toBeInstanceOf(NotFoundException);

    await service.setVisibility(author, created.id, { visibility: 'public' });

    await expect(service.update(colleague, created.id, { displayName: 'Shared' })).resolves.toMatchObject({
      displayName: 'Shared',
    });
    expect(await code(service.setVisibility(colleague, created.id, { visibility: 'private' }))).toBe(
      'visibility_incoherent'
    );
  });

  it('keeps the display name when a patch omits it', async () => {
    const name = skillName();
    const created = await service.create(author, { name, displayName: 'Kept', files: files(name) });

    await expect(service.update(author, created.id, {})).resolves.toMatchObject({ displayName: 'Kept' });
  });

  it('is never editable when it is built in', async () => {
    const id = randomUUID();
    await db.insert(skills).values({ id, name: `built-in-${id}`, origin: 'built_in' });

    await expect(service.update(author, id, { displayName: 'Nope' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('versions', () => {
  it('mints the next version and re-denormalizes the description', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });

    const updated = await service.addVersion(author, created.id, {
      files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription} Revised.`) }],
    });

    expect(updated.latestVersion).toMatchObject({ version: 2 });
    expect(updated.description).toBe(`${validDescription} Revised.`);
    expect((await service.listVersions(author, created.id)).map((version) => version.version)).toEqual([2, 1]);
  });

  it('is refused on a disabled skill', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    await service.setDisabled(author, created.id, true);

    expect(await code(service.addVersion(author, created.id, { files: files(name) }))).toBe('skill_disabled');
  });
});

describe('export and import', () => {
  it('round-trips an exported archive into the next version with the same files', async () => {
    const name = skillName();
    const created = await service.create(author, {
      name,
      files: [
        ...files(name),
        { path: 'references/notes.md', content: '# Notes\n' },
        { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', executable: true },
      ],
    });

    const exported = await service.exportVersion(author, created.id, 1);
    expect(exported.fileName).toBe(`${name}-v1.skill`);

    const unpacked = await unpackSkill(exported.archive);
    expect(unpacked.map((file) => file.path).toSorted()).toEqual(['SKILL.md', 'references/notes.md', 'scripts/run.sh']);

    const imported = await service.import(author, exported.archive);
    expect(imported.id).toBe(created.id);
    expect(imported.latestVersion).toMatchObject({ version: 2 });

    const files2 = await service.listFiles(author, created.id, 2);
    expect(files2.map((file) => file.path).toSorted()).toEqual(unpacked.map((file) => file.path).toSorted());
  });

  it("lands the same tree in another organization, which is what the Skill page's Export offers", async () => {
    const name = skillName();
    const tree = [
      ...files(name),
      { path: 'references/notes.md', content: '# Notes\n' },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', executable: true },
    ];
    const created = await service.create(author, { name, files: tree });

    const exported = await service.exportVersion(author, created.id, 1);
    const imported = await service.import(outsider, exported.archive);

    expect(imported.id).not.toBe(created.id);
    expect(imported.name).toBe(name);
    expect(imported.latestVersion).toMatchObject({ version: 1 });
    expect(await service.listFiles(outsider, imported.id, 1)).toEqual(await service.listFiles(author, created.id, 1));
  });

  it('refuses an import onto a name another member owns privately', async () => {
    const name = skillName();
    const created = await service.create(colleague, { name, files: files(name) });
    const exported = await service.exportVersion(colleague, created.id, 1);

    expect(await code(service.import(author, exported.archive))).toBe('name_unavailable');
  });
});

describe('duplicate', () => {
  it('copies the latest files into a new private skill under the new name', async () => {
    const source = skillName();
    const created = await service.create(colleague, { name: source, files: files(source) });
    await service.setVisibility(colleague, created.id, { visibility: 'public' });

    const copyName = skillName();
    const copy = await service.duplicate(author, created.id, { name: copyName });

    expect(copy).toMatchObject({ name: copyName, visibility: 'private', createdBy: author.userId });
    expect(copy.latestVersion).toMatchObject({ version: 1 });
    const [manifestFile] = await service.listFiles(author, copy.id, 1);
    expect(manifestFile.content).toContain(`name: ${copyName}`);
  });
});

describe('delete', () => {
  it('names the agent while pinned, asks for disabling next, and then deletes', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    const pin = await pinToAgent(tenantId, created.id);

    const refusal = await refusalFor(service, author, created.id);
    expect(refusal.code).toBe('skill_in_use');
    expect(refusal.agents).toEqual([{ id: pin.agentId, displayName: pin.displayName }]);

    await db.delete(agentProfileSkills).where(eq(agentProfileSkills.skillId, created.id));
    expect(await code(service.remove(author, created.id, noProjects))).toBe('skill_not_disabled');

    await service.setDisabled(author, created.id, true);
    await expect(service.remove(author, created.id, noProjects)).resolves.toBeUndefined();
    expect(await db.select({ id: skills.id }).from(skills).where(eq(skills.id, created.id))).toHaveLength(0);
  });

  it('deletes a skill that never had a version without disabling it first', async () => {
    const created = await service.create(author, { name: skillName() });

    await expect(service.remove(author, created.id, noProjects)).resolves.toBeUndefined();
    expect(await db.select({ id: skills.id }).from(skills).where(eq(skills.id, created.id))).toHaveLength(0);
  });

  it('takes its Builder chat with it', async () => {
    const created = await service.create(author, { name: skillName() });
    const chatId = randomUUID();
    const removed: string[][] = [];
    await db
      .insert(projects)
      .values({ id: chatId, tenantId, agentId: await anyAgentId(), kind: 'skill_builder_chat', createdBy: author.userId });
    await db.update(skills).set({ builderChatId: chatId }).where(eq(skills.id, created.id));

    await service.remove(author, created.id, async (ids) => {
      removed.push(ids);
    });

    expect(removed).toEqual([[chatId]]);
  });
});

describe('a skill named before it is written', () => {
  it('starts with no version, private to its author, under the name it was given', async () => {
    const name = skillName();

    const created = await service.create(author, { name, displayName: 'Release Notes' });

    expect(created).toMatchObject({ name, displayName: 'Release Notes', latestVersion: null, visibility: 'private' });
    expect(await service.listVersions(author, created.id)).toEqual([]);
  });

  it('takes its first version like every later one', async () => {
    const name = skillName();
    const created = await service.create(author, { name });

    const published = await service.addVersion(author, created.id, { files: files(name) });

    expect(published.latestVersion?.version).toBe(1);
  });

  it('refuses a name that is not kebab-case, and a name already taken', async () => {
    expect(await code(service.create(author, { name: 'Release Notes' }))).toBe('bad_request');

    const name = skillName();
    await service.create(author, { name });
    expect(await code(service.create(author, { name }))).toBe('name_unavailable');
  });

  it('lists under the created-by-me filter for its author only', async () => {
    const created = await service.create(author, { name: skillName() });

    expect((await service.list(author, 'mine', undefined)).map((row) => row.id)).toContain(created.id);
    expect((await service.list(colleague, 'mine', undefined)).map((row) => row.id)).not.toContain(created.id);
  });
});

describe('the list', () => {
  it('counts the agents carrying a skill and gates the disabled filter', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    await pinToAgent(tenantId, created.id);

    const listed = (await service.list(author, 'all', name)).find((row) => row.id === created.id);
    expect(listed?.usedByAgentCount).toBe(1);

    const member: SkillCaller = { ...author, canManageSkills: false };
    await expect(service.list(member, 'disabled', undefined)).rejects.toThrow(/can_manage_skills/);
  });

  it('counts the agents left behind once a newer version is minted', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    await pinToAgent(tenantId, created.id);

    const pinnedToLatest = (await service.list(author, 'all', name)).find((row) => row.id === created.id);
    expect(pinnedToLatest?.outdatedAgentCount).toBe(0);

    await service.addVersion(author, created.id, { files: files(name, 'Second take.') });

    const behind = (await service.list(author, 'all', name)).find((row) => row.id === created.id);
    expect(behind).toMatchObject({ usedByAgentCount: 1, outdatedAgentCount: 1 });
  });
});

describe('disable and enable', () => {
  it("drops the skill from the default list and puts it back, which is what the page's Undo does", async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });

    await service.setDisabled(author, created.id, true);
    expect((await service.list(author, 'all', name)).map((row) => row.id)).not.toContain(created.id);
    expect((await service.list(author, 'disabled', name)).map((row) => row.id)).toContain(created.id);

    await service.setDisabled(author, created.id, false);
    expect((await service.list(author, 'all', name)).map((row) => row.id)).toContain(created.id);
    expect((await service.list(author, 'disabled', name)).map((row) => row.id)).not.toContain(created.id);
  });
});

describe('the agents carrying a skill', () => {
  it("names every pin, marks the ones behind and keeps another member's private agent out", async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    const carrier = await pinToAgent(tenantId, created.id);
    await pinToAgent(tenantId, created.id, {
      owner: { tenantId, createdBy: colleague.userId, visibility: 'private' },
    });

    const onLatest = await service.listAgents(author, created.id);
    expect(onLatest).toEqual([
      {
        id: carrier.agentId,
        name: expect.stringContaining('agent-'),
        displayName: carrier.displayName,
        pinnedVersions: [1],
        outdated: false,
        omittedIn: 0,
      },
    ]);

    await service.addVersion(author, created.id, { files: files(name, 'Second take.') });

    const behind = await service.listAgents(author, created.id);
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ pinnedVersions: [1], outdated: true });
  });

  it('collapses one agent pinned in two environments into a single row carrying both versions', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    await service.addVersion(author, created.id, { files: files(name, 'Second take.') });

    const carrier = await pinToAgent(tenantId, created.id, { versionId: await versionIdFor(created.id, 1) });
    await pinToAgent(tenantId, created.id, {
      agentId: carrier.agentId,
      versionId: await versionIdFor(created.id, 2),
    });

    const rows = await service.listAgents(author, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: carrier.agentId, pinnedVersions: [1, 2], outdated: true });
  });

  it('counts the environments a name collision dropped it from, and stops counting when it clears', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    const carrier = await pinToAgent(tenantId, created.id);
    const environmentId = await omittingEnvironment(tenantId, carrier.agentId, [name]);

    expect((await service.listAgents(author, created.id))[0]).toMatchObject({ omittedIn: 1 });

    await db
      .update(projectSkillDeliveryState)
      .set({ omittedSkills: [] })
      .where(eq(projectSkillDeliveryState.projectEnvironmentId, environmentId));

    expect((await service.listAgents(author, created.id))[0]).toMatchObject({ omittedIn: 0 });
  });

  it('leaves out the Builder chats and test Projects that no list shows', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    const carrier = await pinToAgent(tenantId, created.id);
    await omittingEnvironment(tenantId, carrier.agentId, [name], 'skill_builder_chat');

    expect((await service.listAgents(author, created.id))[0]).toMatchObject({ omittedIn: 0 });
  });

  it("counts only the collisions in the caller's own Organization", async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });
    const carrier = await pinToAgent(tenantId, created.id);
    await omittingEnvironment(otherTenantId, carrier.agentId, [name]);

    expect((await service.listAgents(author, created.id))[0]).toMatchObject({ omittedIn: 0 });
  });

  it('is empty while no agent carries it and refuses a skill the caller cannot see', async () => {
    const name = skillName();
    const created = await service.create(author, { name, files: files(name) });

    expect(await service.listAgents(author, created.id)).toEqual([]);
    await expect(service.listAgents(outsider, created.id)).rejects.toThrow(NotFoundException);
  });
});

describe('the creator shown on the skill page', () => {
  it("carries the creator's display name, falling back to the email", async () => {
    const named = await createUserRow();
    await db.update(users).set({ displayName: 'Ada Lovelace' }).where(eq(users.id, named));
    const byName: SkillCaller = { tenantId, userId: named, canManageSkills: true };
    const withName = skillName();
    const created = await service.create(byName, { name: withName, files: files(withName) });
    expect((await service.findOne(byName, created.id)).createdByName).toBe('Ada Lovelace');

    const anonymous = await createUserRow();
    await db.update(users).set({ email: 'grace@example.test' }).where(eq(users.id, anonymous));
    const byEmail: SkillCaller = { tenantId, userId: anonymous, canManageSkills: true };
    const emailName = skillName();
    const second = await service.create(byEmail, { name: emailName, files: files(emailName) });
    expect((await service.findOne(byEmail, second.id)).createdByName).toBe('grace@example.test');
  });
});

async function refusalFor(
  skillService: SkillService,
  caller: SkillCaller,
  skillId: string
): Promise<{ code: string; agents: { id: string; displayName: string }[] }> {
  try {
    await skillService.remove(caller, skillId, noProjects);
  } catch (error) {
    return (
      error as { getResponse: () => { code: string; agents: { id: string; displayName: string }[] } }
    ).getResponse();
  }
  throw new Error('the delete was accepted');
}

interface PinOptions {
  /** Left out, the agent is a global built-in one, which every caller can see. */
  owner?: { tenantId: string; createdBy: string; visibility: 'private' | 'public' };
  /** Left out, the pin lands on the skill's current latest version. */
  versionId?: string;
  agentId?: string;
}

async function omittingEnvironment(
  tenant: string,
  agentId: string,
  omittedSkills: string[],
  kind: ProjectKind | null = null
): Promise<string> {
  const projectId = randomUUID();
  const projectEnvironmentId = randomUUID();

  await db.insert(projects).values({ id: projectId, tenantId: tenant, agentId, kind, title: `project-${projectId}` });
  await db.insert(projectEnvironments).values({
    id: projectEnvironmentId,
    projectId,
    directory: `/workspace/${projectId}`,
    platformVersion: 'test',
  });
  await db
    .insert(projectSkillDeliveryState)
    .values({ projectEnvironmentId, converged: true, pendingSkills: [], omittedSkills });

  return projectEnvironmentId;
}

async function pinToAgent(
  tenant: string,
  skillId: string,
  options: PinOptions = {}
): Promise<{ agentId: string; displayName: string }> {
  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  const agentId = options.agentId ?? randomUUID();
  const displayName = `Agent ${agentId.slice(0, 6)}`;
  const environmentId = randomUUID();
  const profileId = randomUUID();

  if (!options.agentId) {
    await db.insert(agents).values({
      id: agentId,
      name: `agent-${agentId}`,
      displayName,
      ...(options.owner
        ? {
            tenantId: options.owner.tenantId,
            origin: 'custom',
            createdBy: options.owner.createdBy,
            visibility: options.owner.visibility,
          }
        : {}),
    });
  }
  await db
    .insert(environments)
    .values({ id: environmentId, tenantId: tenant, name: `env-${environmentId}`, slug: `env-${environmentId}` });
  await db.insert(agentProfiles).values({ id: profileId, agentId, environmentId });
  await db.insert(agentProfileSkills).values({
    profileId,
    skillId,
    skillVersionId: options.versionId ?? (skill.latestVersionId as string),
  });

  return { agentId, displayName };
}

async function versionIdFor(skillId: string, version: number): Promise<string> {
  const [row] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
    .limit(1);
  return row.id;
}

describe('disabling a built-in skill for one Organization (ADR-0072)', () => {
  it('takes it out of that Organization only, and back on enable', async () => {
    const { skillId } = await ensureBuiltInSkill('csv-digest');
    const elsewhere = await createCaller(otherTenantId);

    expect((await service.setDisabled(author, skillId, true)).disabled).toBe(true);

    expect((await service.list(author, 'all', undefined)).map((row) => row.id)).not.toContain(skillId);
    expect((await service.list(author, 'disabled', undefined)).map((row) => row.id)).toContain(skillId);
    expect((await service.findOne(elsewhere, skillId)).disabled).toBe(false);

    expect((await service.setDisabled(author, skillId, false)).disabled).toBe(false);
  });

  it('refuses to add a disabled built-in skill to an agent there', async () => {
    const { skillId } = await ensureBuiltInSkill('csv-digest');
    await harness.environments.ensureDefaultForTenant(tenantId);
    const agentCaller = { tenantId, userId: author.userId, canManageAgents: true };
    const agent = await harness.agents.create(agentCaller, { displayName: `Agent ${randomUUID().slice(0, 8)}` });
    await service.setDisabled(author, skillId, true);

    expect(await code(harness.agents.setSkill(agentCaller, agent.id, skillId, {}))).toBe('skill_disabled');

    await service.setDisabled(author, skillId, false);
  });

  it('keeps the platform skill on, says so up front, and asks for can_manage_skills', async () => {
    const platform = await ensureBuiltInSkill('platform');
    const { skillId } = await ensureBuiltInSkill('csv-digest');

    expect((await service.findOne(author, platform.skillId)).disableable).toBe(false);
    expect((await service.findOne(author, skillId)).disableable).toBe(true);
    expect(await code(service.setDisabled(author, platform.skillId, true))).toBe('not_disableable');
    await expect(service.setDisabled({ ...author, canManageSkills: false }, skillId, true)).rejects.toThrow(
      Perms.manageSkills
    );
  });
});

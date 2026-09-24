import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentSettings, agents, skills } from '../../db/schema';
import { AgentController } from '../../src/agent/agent.controller';
import { EnvironmentService } from '../../src/environment/environment.service';
import { Perms } from '../../src/permission/permission.constants';
import { SkillsController } from '../../src/store/skills.controller';
import { ensureBuiltInAgent, ensureBuiltInSkill, seedLiveAgent } from '../support/agent-fixtures';
import { createTenantRow } from '../support/org-fixtures';
import {
  addMember,
  createOrganization,
  createProject,
  platformApiKeyFor,
  stampProjectKind,
  type MemberFixture,
  type OrganizationFixture,
} from '../support/project-fixtures';
import { organizationName, proxyHeaders } from '../support/proxy-identity';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';

/** The internal Store surface, mounted so a gateway caller can be shown to miss it. */
@Module({ controllers: [SkillsController, AgentController] })
class InternalStoreModule {}

const AUTHORING = [Perms.usePublicApi, Perms.manageSkills, Perms.manageAgents];

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function skillName(): string {
  return `skill-${randomUUID().slice(0, 8)}`;
}

function description(): string {
  return 'Use this skill whenever the project needs a worked example of the thing it describes, including setup, pitfalls and review steps.';
}

function tree(name: string, body = '# Body\n'): { path: string; content: string }[] {
  return [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description()}\n---\n\n${body}` }];
}

describe('the Store routes of /api/v1', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let organization: string;
  let tenantId: string;
  let author: Record<string, string>;
  let bystander: Record<string, string>;

  beforeAll(async () => {
    organization = organizationName();
    tenantId = await createTenantRow(organization);
    harness = await createPublicApiTestApp({}, [InternalStoreModule]);
    app = harness.app;
    await app.get(EnvironmentService).ensureDefaultForTenant(tenantId);

    author = proxyHeaders({ organizations: [organization], permissions: AUTHORING });
    bystander = proxyHeaders({ organizations: [organization], permissions: [Perms.usePublicApi] });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function createSkill(headers: Record<string, string>, name = skillName()) {
    return app.inject({ method: 'POST', url: '/api/v1/skills', headers, payload: { name, files: tree(name) } });
  }

  async function createAgent(label: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: author,
      payload: { displayName: `${label} ${randomUUID().slice(0, 6)}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id;
  }

  describe('authoring a Skill', () => {
    it('refuses a caller without can_manage_skills, naming the permission', async () => {
      const res = await createSkill(bystander);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:permission-denied',
        permission: Perms.manageSkills,
      });
    });

    it('creates it private at Version 1 for a holder', async () => {
      const name = skillName();

      const res = await createSkill(author, name);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        name,
        origin: 'custom',
        visibility: 'private',
        disabled: false,
        usedByAgentCount: 0,
        latestVersion: { version: 1, flags: { hasExecutables: false } },
      });
    });

    it('refuses a name the deployment already carries', async () => {
      const name = skillName();
      await createSkill(author, name);

      const again = await createSkill(author, name);

      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ type: 'urn:opsiforce:error:name-unavailable' });
      expect(harness.problems).toContainEqual({
        method: 'POST',
        url: '/api/v1/skills',
        type: 'urn:opsiforce:error:name-unavailable',
      });
    });

    it('answers a failed gate with every finding, its rule and its file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: author,
        payload: { name: 'Not Kebab Case', files: tree('Not Kebab Case') },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.type).toBe('urn:opsiforce:error:validation-failed');
      expect(body.errors.length).toBeGreaterThan(0);
      expect(body.errors[0]).toMatchObject({ pointer: '#/files', in: 'body', rule: expect.any(String) });
      expect(Array.isArray(body.lints)).toBe(true);
    });

    it('validates a tree without writing anything', async () => {
      const name = skillName();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/skills/validate',
        headers: author,
        payload: { name, files: tree(name) },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ valid: true, errors: [], flags: { hasExecutables: false } });

      const [row] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
      expect(row).toBeUndefined();
    });

    it('reads the files of a Version back', async () => {
      const name = skillName();
      const created = await createSkill(author, name);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/skills/${created.json().id}/versions/1/files`,
        headers: author,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items[0]).toMatchObject({ path: 'SKILL.md', isBinary: false, isExecutable: false });
    });

    it('duplicates a Skill under a new name', async () => {
      const source = await createSkill(author);
      const name = skillName();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/skills/${source.json().id}/duplicate`,
        headers: author,
        payload: { name },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name, visibility: 'private', latestVersion: { version: 1 } });
    });

    it('lists what the caller may see, and filters by name', async () => {
      const name = skillName();
      await createSkill(author, name);

      const all = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: author });
      expect(all.statusCode).toBe(200);
      expect(all.json().items.map((item: { name: string }) => item.name)).toContain(name);

      const searched = await app.inject({ method: 'GET', url: `/api/v1/skills?q=${name}`, headers: author });
      expect(searched.json().items.map((item: { name: string }) => item.name)).toEqual([name]);

      const custom = await app.inject({ method: 'GET', url: '/api/v1/skills?filter=built_in', headers: author });
      expect(custom.json().items.map((item: { name: string }) => item.name)).not.toContain(name);
    });

    it('keeps the disabled filter behind can_manage_skills', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/skills?filter=disabled', headers: bystander });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:permission-denied',
        permission: Perms.manageSkills,
      });
    });

    it('answers 404 for a Skill the caller cannot see, before weighing the permission', async () => {
      const mine = await createSkill(author);
      const stranger = proxyHeaders({ organizations: [organization], permissions: AUTHORING });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/skills/${mine.json().id}/versions`,
        headers: stranger,
        payload: { files: tree('anything') },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('a Skill on an Agent', () => {
    it('pins the latest Version, then reports the update a new Version makes available', async () => {
      const agent = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers: author,
        payload: { displayName: `Round Trip ${randomUUID().slice(0, 6)}` },
      });
      expect(agent.statusCode).toBe(201);
      const agentId = agent.json().id;

      const name = skillName();
      const skill = await createSkill(author, name);
      const skillId = skill.json().id;

      const added = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agentId}/skills/${skillId}`,
        headers: author,
        payload: {},
      });
      expect(added.statusCode).toBe(200);
      expect(added.json().items).toContainEqual(
        expect.objectContaining({ skillId, pinnedVersion: 1, latestVersion: 1, updateAvailable: false })
      );

      const before = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}`, headers: author });
      expect(pinnedSkill(before.json(), skillId)).toMatchObject({ pinnedVersion: 1, updateAvailable: false });

      const published = await app.inject({
        method: 'POST',
        url: `/api/v1/skills/${skillId}/versions`,
        headers: author,
        payload: { files: tree(name, '# Second\n') },
      });
      expect(published.statusCode).toBe(201);
      expect(published.json().latestVersion.version).toBe(2);

      const after = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}`, headers: author });
      expect(pinnedSkill(after.json(), skillId)).toMatchObject({
        pinnedVersion: 1,
        latestVersion: 2,
        updateAvailable: true,
      });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/agents/${agentId}/skills/${skillId}`,
        headers: author,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().items.map((item: { skillId: string }) => item.skillId)).not.toContain(skillId);
    });

    it('marks an Environment with no profile with skills null', async () => {
      const agent = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers: author,
        payload: { displayName: `Profiles ${randomUUID().slice(0, 6)}` },
      });

      const profiles = agent.json().profiles;
      expect(profiles.length).toBeGreaterThan(0);
      for (const profile of profiles) expect(profile).toHaveProperty('environmentId', expect.any(String));
      expect(profiles.filter((profile: { skills: unknown }) => profile.skills !== null).length).toBe(1);
    });

    it('reads the Skill set of an Agent on its own route', async () => {
      const agent = await createAgent('Skill Set');
      const skill = await createSkill(author);

      await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agent}/skills/${skill.json().id}`,
        headers: author,
        payload: {},
      });

      const res = await app.inject({ method: 'GET', url: `/api/v1/agents/${agent}/skills`, headers: author });

      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((item: { skillId: string }) => item.skillId)).toContain(skill.json().id);
    });

    it('refuses a model the running distribution does not carry', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers: author,
        payload: { displayName: `Bad Model ${randomUUID().slice(0, 6)}`, model: 'nowhere/no-such-model' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:model-unknown' });
    });

    it('refuses a profile edit on an Agent the agent image owns', async () => {
      const builtIn = await ensureBuiltInAgent(`built-in-${randomUUID().slice(0, 8)}`);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${builtIn}/profile`,
        headers: author,
        payload: { promptBody: 'nope', model: 'openai/gpt-5.6-sol' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:not-publishable' });
    });

    it('refuses a private Skill on an Agent the whole Organization can see', async () => {
      const agentId = await createAgent('Public Agent');
      await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, agentId));
      const skill = await createSkill(author);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agentId}/skills/${skill.json().id}`,
        headers: author,
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:visibility-incoherent' });
    });

    it('refuses a second Skill of a name the Agent already carries', async () => {
      const agentId = await createAgent('Colliding');
      const name = skillName();
      const mine = await createSkill(author, name);

      await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agentId}/skills/${mine.json().id}`,
        headers: author,
        payload: {},
      });

      // A name can only collide once a Built-in Skill arrives under it, which no route can do.
      const shadow = await ensureBuiltInSkill(name);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agentId}/skills/${shadow.skillId}`,
        headers: author,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:duplicate-skill-name' });
    });

    it('refuses an Agent write to a caller without can_manage_agents', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers: bystander,
        payload: { displayName: 'Refused' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ permission: Perms.manageAgents });
    });
  });
});

function pinnedSkill(detail: { profiles: { skills: { skillId: string }[] | null }[] }, skillId: string) {
  return detail.profiles.flatMap((profile) => profile.skills ?? []).find((skill) => skill.skillId === skillId);
}

describe('the Store routes seen by an Agent Caller', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let organization: OrganizationFixture;
  let creator: MemberFixture;
  let chatProjectId: string;
  let chatKey: string;

  async function platformApiAgent(): Promise<string> {
    const agent = await seedLiveAgent(organization.tenantId, creator.userId);
    await db.update(agentSettings).set({ platformApi: true }).where(eq(agentSettings.agentId, agent.id));
    return agent.id;
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp({}, [InternalStoreModule]);
    app = harness.app;

    organization = await createOrganization(app);
    creator = await addMember(app, organization, AUTHORING);
    const agentId = await platformApiAgent();

    chatProjectId = await createProject(app, organization, { agentId, createdBy: creator.userId });
    await stampProjectKind(chatProjectId, 'agent_builder_chat');
    chatKey = await platformApiKeyFor(app, organization, chatProjectId);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function createSkillAsPod(): Promise<string> {
    const name = skillName();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: bearer(chatKey),
      payload: { name, files: tree(name) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("authors a Skill its Agent needs without making it the chat's subject", async () => {
    const skillId = await createSkillAsPod();

    const res = await app.inject({ method: 'GET', url: `/api/v1/skills/${skillId}`, headers: bearer(chatKey) });

    expect(res.json()).toMatchObject({ createdBy: creator.userId, builderChatId: null });
  });

  it('renames a Skill, keeps its name, and falls back to the name on null', async () => {
    const skillId = await createSkillAsPod();
    const name = (
      await app.inject({ method: 'GET', url: `/api/v1/skills/${skillId}`, headers: bearer(chatKey) })
    ).json().name;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skills/${skillId}`,
      headers: bearer(chatKey),
      payload: { displayName: 'Release Notes' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name, displayName: 'Release Notes' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skills/${skillId}`,
      headers: bearer(chatKey),
      payload: { displayName: null },
    });
    expect(cleared.json()).toMatchObject({ name, displayName: null });

    const renamingTheName = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skills/${skillId}`,
      headers: bearer(chatKey),
      payload: { name: 'something-else' },
    });
    expect(renamingTheName.statusCode).toBe(400);
  });

  it('reads the Agent its chat authors off /me, then describes and renames it', async () => {
    const subject = await seedLiveAgent(organization.tenantId, creator.userId, { visibility: 'private' });
    await db.update(agents).set({ builderChatId: chatProjectId }).where(eq(agents.id, subject.id));

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(chatKey) });
    expect(me.json().builderSubject).toMatchObject({ type: 'agent', id: subject.id, name: subject.name });

    const described = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${subject.id}`,
      headers: bearer(chatKey),
      payload: { description: 'Turns merged pull requests into release notes' },
    });
    expect(described.statusCode).toBe(200);
    expect(described.json()).toMatchObject({
      name: subject.name,
      description: 'Turns merged pull requests into release notes',
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${subject.id}`,
      headers: bearer(chatKey),
      payload: { displayName: 'Release Notes' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      name: subject.name,
      displayName: 'Release Notes',
      description: 'Turns merged pull requests into release notes',
    });

    const blank = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${subject.id}`,
      headers: bearer(chatKey),
      payload: { displayName: '  ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('finds no destructive verb on /api/v1, though its creator holds both permissions', async () => {
    const skillId = await createSkillAsPod();

    const absent = await Promise.all([
      app.inject({ method: 'DELETE', url: `/api/v1/skills/${skillId}`, headers: bearer(chatKey) }),
      app.inject({ method: 'POST', url: `/api/v1/skills/${skillId}/disable`, headers: bearer(chatKey) }),
      app.inject({
        method: 'POST',
        url: `/api/v1/skills/${skillId}/visibility`,
        headers: bearer(chatKey),
        payload: { visibility: 'public' },
      }),
      app.inject({ method: 'POST', url: `/api/v1/agents/${chatProjectId}/publish`, headers: bearer(chatKey) }),
      app.inject({ method: 'POST', url: `/api/v1/agents/${chatProjectId}/disable`, headers: bearer(chatKey) }),
      app.inject({
        method: 'POST',
        url: `/api/v1/agents/${chatProjectId}/visibility`,
        headers: bearer(chatKey),
        payload: { visibility: 'public' },
      }),
    ]);

    for (const res of absent) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:route-not-found' });
    }
  });

  it('cannot reach the internal Store surface, which wants identity headers it does not have', async () => {
    const skillId = await createSkillAsPod();

    const internal = await app.inject({ method: 'DELETE', url: `/api/skills/${skillId}`, headers: bearer(chatKey) });

    expect([401, 403]).toContain(internal.statusCode);
    const still = await app.inject({ method: 'GET', url: `/api/v1/skills/${skillId}`, headers: bearer(chatKey) });
    expect(still.statusCode).toBe(200);
  });
});

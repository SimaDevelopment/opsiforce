import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, environments } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { AgentController } from '../../src/agent/agent.controller';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { TranscriptionAvailabilityController } from '../../src/transcription/transcription-availability.controller';
import { TranscriptionAvailabilityService } from '../../src/transcription/transcription-availability.service';
import { seedLiveAgent } from '../support/agent-fixtures';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];

@Module({
  controllers: [AgentController, TranscriptionAvailabilityController],
  providers: [TranscriptionAvailabilityService],
})
class ReachabilityReadersModule {}

async function productionOf(tenant: TenantFixture): Promise<string> {
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenant.tenantId), eq(environments.isDefault, false)))
    .limit(1);
  return production.id;
}

async function agentOn(tenant: TenantFixture, author: MemberFixture, model: string) {
  const agent = await seedLiveAgent(tenant.tenantId, author.userId, { visibility: 'private' });
  await db.update(agentProfiles).set({ model }).where(eq(agentProfiles.agentId, agent.id));
  return agent;
}

describe('reachability of Base formats', () => {
  let bifrost: FakeBifrost;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    bifrost.setProviderKeyed('openai', true);
    harness = await createPublicApiTestApp(
      bifrost.env,
      [ModelProvidersModule, ReachabilityReadersModule],
      [BifrostService]
    );
    app = harness.app;
  });

  afterEach(() => {
    bifrost.becomeReachable();
    bifrost.setProviders(HELM_PROVIDERS);
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
  });

  async function seededTenant(): Promise<{ tenant: TenantFixture; admin: MemberFixture; member: MemberFixture }> {
    const tenant = await createTenant(app);
    return {
      tenant,
      admin: await addMember(app, tenant, [Perms.manageTenantModelProviders]),
      member: await addMember(app, tenant, []),
    };
  }

  function saveFormat(
    admin: MemberFixture,
    format: string,
    providers: { name: string; chatEnabled: boolean; chatWeight: number }[],
    extra: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: 'PUT',
      url: `/api/model-providers/formats/${format}`,
      headers: admin.headers,
      payload: { providers, ...extra },
    });
  }

  async function switchOff(admin: MemberFixture, format: 'openai' | 'anthropic') {
    const providers =
      format === 'openai'
        ? [
            { name: 'openai', chatEnabled: false, chatWeight: 0 },
            { name: 'custom-openai-1', chatEnabled: false, chatWeight: 1 },
          ]
        : [{ name: 'anthropic', chatEnabled: false, chatWeight: 1 }];
    const res = await saveFormat(admin, format, providers, { acknowledgeAffectedAgents: true });
    expect(res.statusCode, res.body).toBe(200);
  }

  function reachableModelsRead(member: MemberFixture) {
    return app.inject({ method: 'GET', url: '/api/model-providers/reachable-models', headers: member.headers });
  }

  async function reachableFormats(member: MemberFixture): Promise<{ json: () => string[] }> {
    const res = await reachableModelsRead(member);
    expect(res.statusCode, res.body).toBe(200);
    const formats = [...new Set(res.json<string[]>().map((ref) => ref.slice(0, ref.indexOf('/'))))];
    return { json: () => formats };
  }

  describe('the reachable-models read', () => {
    it('answers a member with no admin permission with only the models of the reachable formats', async () => {
      const { admin, member } = await seededTenant();
      await switchOff(admin, 'anthropic');

      const res = await reachableModelsRead(member);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toContain('openai/gpt-5.6-sol');
      expect(res.json<string[]>().every((ref) => ref.startsWith('openai/'))).toBe(true);
    });

    it('drops a format whose only enabled row is missing from Bifrost', async () => {
      const { admin, member } = await seededTenant();
      await switchOff(admin, 'openai');
      bifrost.setProviders(['openai', 'anthropic']);

      const res = await saveFormat(admin, 'openai', [{ name: 'openai', chatEnabled: true, chatWeight: 1 }]);
      expect(res.statusCode, res.body).toBe(200);
      expect((await reachableFormats(member)).json()).toEqual(['openai', 'anthropic']);

      bifrost.setProviders(['anthropic', 'custom-openai-1']);
      expect((await reachableFormats(member)).json()).toEqual(['anthropic']);
    });
  });

  describe('the Agent Profile model catalog', () => {
    function catalogProviders(member: MemberFixture) {
      return app.inject({ method: 'GET', url: '/api/agents/models', headers: member.headers });
    }

    it('lists only the models of the formats the Organization can reach', async () => {
      const { admin, member } = await seededTenant();
      await switchOff(admin, 'anthropic');

      const res = await catalogProviders(member);

      expect(res.statusCode, res.body).toBe(200);
      const models = res.json<{ id: string; models: { id: string }[] }[]>();
      expect(models.map((provider) => provider.id)).toEqual(['openai']);
      expect(models[0]?.models.map((model) => model.id)).toContain('openai/gpt-5.6-sol');
    });

    it('lists every format while all of them are reachable', async () => {
      const { member } = await seededTenant();

      const res = await catalogProviders(member);

      expect(
        res
          .json<{ id: string }[]>()
          .map((provider) => provider.id)
          .toSorted()
      ).toEqual(['anthropic', 'openai']);
    });
  });

  describe('choosing an Agent Profile model', () => {
    async function authoredAgent() {
      const seeded = await seededTenant();
      const author = await addMember(app, seeded.tenant, [Perms.manageAgents]);
      const agent = await seedLiveAgent(seeded.tenant.tenantId, author.userId);
      return { ...seeded, author, agentId: agent.id };
    }

    function saveProfile(author: MemberFixture, agentId: string, model: string, promptBody = 'Be brief.') {
      return app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/profile`,
        headers: author.headers,
        payload: { promptBody, model, variant: null },
      });
    }

    it('refuses changing the model to one of a format the Organization cannot reach', async () => {
      const { admin, author, agentId } = await authoredAgent();
      await switchOff(admin, 'anthropic');

      const res = await saveProfile(author, agentId, 'anthropic/claude-sonnet-5');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'model_unreachable', part: 'model' });
    });

    it('saves an unchanged unreachable model, and Publish copies it as is', async () => {
      const { tenant, admin, author, agentId } = await authoredAgent();
      await switchOff(admin, 'openai');

      const saved = await saveProfile(author, agentId, 'openai/gpt-5.6-sol', 'Answer in French.');
      expect(saved.statusCode, saved.body).toBe(200);

      const productionId = await productionOf(tenant);
      const published = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/publish`,
        headers: author.headers,
        payload: { environmentId: productionId },
      });
      expect(published.statusCode, published.body).toBe(200);
      const [production] = await db
        .select({ model: agentProfiles.model, promptBody: agentProfiles.promptBody })
        .from(agentProfiles)
        .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, productionId)));
      expect(production).toEqual({ model: 'openai/gpt-5.6-sol', promptBody: 'Answer in French.' });
    });

    it('accepts changing the model to one of a reachable format', async () => {
      const { admin, author, agentId } = await authoredAgent();
      await switchOff(admin, 'openai');

      const res = await saveProfile(author, agentId, 'anthropic/claude-sonnet-5');

      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('dictation availability', () => {
    function availability(member: MemberFixture) {
      return app.inject({ method: 'GET', url: '/api/transcription/availability', headers: member.headers });
    }

    it('is available to an Organization whose built-in openai is on', async () => {
      const { member } = await seededTenant();

      const res = await availability(member);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ available: boolean }>().available).toBe(true);
    });

    it('is unavailable to an Organization that switched its built-in openai off, even with another OpenAI provider on', async () => {
      const { admin, member } = await seededTenant();
      const saved = await saveFormat(admin, 'openai', [
        { name: 'openai', chatEnabled: false, chatWeight: 0 },
        { name: 'custom-openai-1', chatEnabled: true, chatWeight: 1 },
      ]);
      expect(saved.statusCode, saved.body).toBe(200);

      const res = await availability(member);

      expect(res.json<{ available: boolean }>().available).toBe(false);
      expect((await availability((await seededTenant()).member)).json<{ available: boolean }>().available).toBe(true);
    });
  });

  describe('the switch-off warning', () => {
    const OPENAI_OFF = [
      { name: 'openai', chatEnabled: false, chatWeight: 0 },
      { name: 'custom-openai-1', chatEnabled: false, chatWeight: 1 },
    ];

    it('lists the Custom and Built-in Agents on the format and changes nothing without the acknowledgement', async () => {
      const { tenant, admin, member } = await seededTenant();
      const builtInId = await createAgent();
      const onOpenAi = await agentOn(tenant, admin, 'openai/gpt-6-astra');
      const onAnthropic = await agentOn(tenant, admin, 'anthropic/claude-sonnet-5');
      const neighbour = await seededTenant();
      const neighbourAgent = await agentOn(neighbour.tenant, neighbour.admin, 'openai/gpt-5.6-sol');

      const res = await saveFormat(admin, 'openai', OPENAI_OFF);

      expect(res.statusCode).toBe(409);
      const body = res.json<{ code: string; format: string; agents: { id: string; name: string; origin: string }[] }>();
      expect(body).toMatchObject({ code: 'agents_affected', format: 'openai' });
      expect(body.agents).toContainEqual({ id: onOpenAi.id, name: onOpenAi.displayName, origin: 'custom' });
      expect(body.agents).toContainEqual(expect.objectContaining({ id: builtInId, origin: 'built_in' }));
      const listed = body.agents.map((agent) => agent.id);
      expect(listed).not.toContain(onAnthropic.id);
      expect(listed).not.toContain(neighbourAgent.id);
      expect((await reachableFormats(member)).json()).toEqual(['openai', 'anthropic']);
    });

    it('applies the save once the request acknowledges the affected Agents', async () => {
      const { tenant, admin, member } = await seededTenant();
      await createAgent();
      await agentOn(tenant, admin, 'openai/gpt-6-astra');

      const res = await saveFormat(admin, 'openai', OPENAI_OFF, { acknowledgeAffectedAgents: true });

      expect(res.statusCode, res.body).toBe(200);
      expect((await reachableFormats(member)).json()).toEqual(['anthropic']);
    });

    it('does not warn when the format stays reachable', async () => {
      const { tenant, admin } = await seededTenant();
      await createAgent();
      await agentOn(tenant, admin, 'openai/gpt-6-astra');

      const res = await saveFormat(admin, 'openai', [
        { name: 'openai', chatEnabled: false, chatWeight: 0 },
        { name: 'custom-openai-1', chatEnabled: true, chatWeight: 1 },
      ]);

      expect(res.statusCode, res.body).toBe(200);
    });
  });
});

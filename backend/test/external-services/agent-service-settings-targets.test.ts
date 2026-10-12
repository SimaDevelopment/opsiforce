import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agents, skills } from '../../db/schema';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import { Perms } from '../../src/permission/permission.constants';
import { ProjectService } from '../../src/project/project.service';
import { seedLiveAgent } from '../support/agent-fixtures';
import { addMember, createTenant, serviceKeyFor } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration, platformOperator } from './support/fixtures';
import { callOperation } from './support/gate';
import {
  channelsOf,
  fixtureKeysEvolved,
  forgetRecordedHooks,
  KEYS_SERVICE,
  READY_KEYS,
  recordedHook,
  saveServiceConfiguration,
  type EvolvedKeys,
} from './support/generating';

type FieldJson = Record<string, unknown> & { key?: string };

describe('service settings against a service whose targets are required and which grew an Operation', () => {
  let evolved: EvolvedKeys;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let supportChannelId: string;

  beforeAll(async () => {
    evolved = await fixtureKeysEvolved((manifest) => {
      const channel = (manifest.projectForm as FieldJson[]).find((field) => field.key === 'channel');
      if (channel) channel.required = true;
      (manifest.operations as Record<string, unknown>).list_messages = {
        kind: 'read',
        description: 'List the latest messages of the picked channel.',
        input: { type: 'object', properties: {}, additionalProperties: false },
      };
    });
    const handlers = join(evolved.dir, KEYS_SERVICE, 'handlers.ts');
    await writeFile(
      handlers,
      (await readFile(handlers, 'utf8'))
        .replace(
          'operations: { send_message: (input) => input },',
          'operations: { send_message: (input) => input, list_messages: () => ({ messages: [] }) },'
        )
        .replace(
          'inbound:',
          `hooks: {
    onProjectConfigurationSaved: ({ previous, current }, ctx) => {
      globalThis[Symbol.for('opsiforce.test.fixture-keys.hooks')]?.set(\`hooks/project/\${ctx.caller?.environmentId}\`, {
        previous: previous ?? null,
        currentChannel: current?.channel ?? null,
      });
    },
  },
  inbound:`
        )
    );
    harness = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
    app = harness.app;
    serviceId = await builtInServiceId(KEYS_SERVICE);
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    const saved = await saveServiceConfiguration(app, await platformOperator(app), serviceId, READY_KEYS);
    supportChannelId = channelsOf(saved.json())[0].id;
    forgetRecordedHooks();
  });

  afterAll(async () => {
    await harness.close();
    await evolved.remove();
  });

  it('creates the configuration "Needs attention" without running the save hook until someone picks the targets, whose save hook gets no previous configuration, and calls answer 409', async () => {
    const tenant = await createTenant(app);
    const manager = await addMember(app, tenant, [Perms.manageAgents, Perms.configureProjectExternalServices]);
    const seeded = await seedLiveAgent(tenant.tenantId, manager.userId);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seeded.id));
    const agent = { ...agentRow, disabled: false };
    const caller = { tenantId: tenant.tenantId, userId: manager.userId, canManageAgents: true };
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.externalServiceId, serviceId));
    await app.get(AgentProfileService).setSkill(agent, caller, skill.id, {});
    await db
      .update(agentProfileSkills)
      .set({ serviceSettings: { operations: ['send_message'], receive: [] } })
      .where(eq(agentProfileSkills.skillId, skill.id));

    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, tenant.tenantId, { createdBy: manager.userId });

    const services = `/api/external-services/projects/${project.id}/environments/${project.id}/services`;
    const view = await app.inject({ method: 'GET', url: `${services}/${serviceId}`, headers: manager.headers });
    expect(view.json().projectConfiguration).toMatchObject({
      saved: true,
      missing: ['channel'],
      operations: { send_message: true, list_messages: false },
    });
    expect(view.json().hookFailure).toBeNull();
    expect(recordedHook(`hooks/project/${project.id}`)).toBeUndefined();
    const list = await app.inject({ method: 'GET', url: services, headers: manager.headers });
    expect(
      (list.json().services as { id: string; configuration: unknown }[]).find((service) => service.id === serviceId)
        ?.configuration
    ).toMatchObject({ saved: true, missing: ['channel'] });
    const call = await callOperation(app, {
      key: await serviceKeyFor(app, tenant, project.id),
      slug: KEYS_SERVICE,
      operation: 'send_message',
      input: { channel: 'any', text: 'hello' },
    });
    expect(call.statusCode, call.body).toBe(409);
    expect(call.json()).toMatchObject({ code: 'configuration-incomplete' });

    const picked = await app.inject({
      method: 'PUT',
      url: `${services}/${serviceId}/configuration`,
      headers: manager.headers,
      payload: { values: { channel: supportChannelId } },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(recordedHook(`hooks/project/${project.id}`)).toEqual({ previous: null, currentChannel: supportChannelId });
  });
});

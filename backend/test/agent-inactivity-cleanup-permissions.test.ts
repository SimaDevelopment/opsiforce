import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentController } from '../src/agent/agent.controller';
import { seedLiveAgent } from './support/agent-fixtures';
import { addMember, createTenant, type MemberFixture } from './support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './public-api/support/app';

const DAY_MS = 24 * 60 * 60 * 1000;

@Module({ controllers: [AgentController] })
class AgentRoutesModule {}

let harness: PublicApiTestApp;
let app: NestFastifyApplication;

beforeAll(async () => {
  harness = await createPublicApiTestApp({}, [AgentRoutesModule]);
  app = harness.app;
});

afterAll(async () => {
  await harness.close();
});

async function authoredAgent(permissions: string[]) {
  const tenant = await createTenant(app);
  const author = await addMember(app, tenant, ['can_manage_agents', ...permissions]);
  const agent = await seedLiveAgent(tenant.tenantId, author.userId, { visibility: 'private' });
  return { author, agentId: agent.id };
}

function saveCleanup(author: MemberFixture, agentId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/api/agents/${agentId}/inactivity-cleanup`,
    headers: author.headers,
    payload,
  });
}

function resetCleanup(author: MemberFixture, agentId: string) {
  return app.inject({ method: 'DELETE', url: `/api/agents/${agentId}/inactivity-cleanup`, headers: author.headers });
}

describe('an Agent’s Inactivity cleanup days', () => {
  it('are refused from an author who cannot disable or delete Projects, so no one schedules what they could not do', async () => {
    const { author, agentId } = await authoredAgent([]);

    const deleteAfter = await saveCleanup(author, agentId, { deleteAfter: 30 * DAY_MS });
    const disableAfter = await saveCleanup(author, agentId, { disableAfter: 14 * DAY_MS });
    const reset = await resetCleanup(author, agentId);

    expect([deleteAfter.statusCode, disableAfter.statusCode, reset.statusCode]).toEqual([403, 403, 403]);
  });

  it('are saved as the Agent’s own pair for an author who may disable and delete Projects', async () => {
    const { author, agentId } = await authoredAgent(['can_disable_project', 'can_delete_project']);

    const res = await saveCleanup(author, agentId, { disableAfter: 14 * DAY_MS, deleteAfter: 30 * DAY_MS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      inactivityCleanup: { source: 'own', cleanup: { disableAfter: 14 * DAY_MS, deleteAfter: 30 * DAY_MS } },
    });
  });
});

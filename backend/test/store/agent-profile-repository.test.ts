import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agents, environments, tenants } from '../../db/schema';
import {
  assertDevelopmentProfile,
  builtInProfileFor,
  NoDevelopmentEnvironment,
  NotADevelopmentProfile,
} from '../../src/store/agent-profile.repository';

let tenantId: string;
let developmentId: string;
let stagingId: string;
let agentId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await db.insert(tenants).values({ id: tenantId, name: `org-${tenantId}`, displayName: 'Org' });

  developmentId = randomUUID();
  stagingId = randomUUID();
  await db.insert(environments).values([
    { id: developmentId, tenantId, name: 'Development', slug: 'development', isDefault: true },
    { id: stagingId, tenantId, name: 'Staging', slug: 'staging', isDefault: false },
  ]);

  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, name: `agent-${agentId}` });
});

describe('the agent profile invariants', () => {
  it('parks a built-in agent on the development environment and reads the same row back', async () => {
    const first = await builtInProfileFor(agentId, tenantId);
    const second = await builtInProfileFor(agentId, tenantId);

    expect(first.environmentId).toBe(developmentId);
    expect(first).toMatchObject({ promptBody: null, model: null, variant: null });
    expect(second.id).toBe(first.id);
  });

  it('accepts a development profile and refuses one parked elsewhere', async () => {
    const development = await builtInProfileFor(agentId, tenantId);
    await expect(assertDevelopmentProfile(development)).resolves.toBeUndefined();

    await expect(assertDevelopmentProfile({ ...development, environmentId: stagingId })).rejects.toThrow(
      NotADevelopmentProfile
    );
  });

  it('refuses an organization with no default environment', async () => {
    const empty = randomUUID();
    await db.insert(tenants).values({ id: empty, name: `org-${empty}`, displayName: 'Empty' });

    await expect(builtInProfileFor(agentId, empty)).rejects.toThrow(NoDevelopmentEnvironment);
  });
});

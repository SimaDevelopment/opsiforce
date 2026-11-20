import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentPodSettings, agentSettings, agents, tenants, users } from '../../db/schema';
import { AgentReconcilerService } from '../../src/agent/agent-reconciler.service';
import type { AgentRegistry, AgentRegistryEntry } from '../../src/agent/agent-config';

const reconciler = new AgentReconcilerService();

let tenantId: string;
let author: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await db.insert(tenants).values({ id: tenantId, name: `org-${tenantId}`, displayName: 'Org' });
  author = randomUUID();
  await db.insert(users).values({ id: author, keycloakId: `kc-${author}` });
});

function registryOf(slug: string, entry: AgentRegistryEntry): AgentRegistry {
  return { agents: { [slug]: entry } };
}

async function globalRow(name: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.name, name), isNull(agents.tenantId)))
    .limit(1);
  return row;
}

async function presetOf(agentId: string): Promise<string | null | undefined> {
  const [row] = await db.select().from(agentPodSettings).where(eq(agentPodSettings.agentId, agentId));
  return row?.presetId;
}

async function poolSizeOf(agentId: string): Promise<number | undefined> {
  const [row] = await db.select().from(agentSettings).where(eq(agentSettings.agentId, agentId));
  return row?.warmPoolSize;
}

describe('the agent reconciler', () => {
  it('stamps the registry fields on the global row and its pool size on the agent settings', async () => {
    const slug = `agent-${randomUUID()}`;
    await reconciler.reconcile(
      registryOf(slug, {
        name: 'Builder',
        description: 'builds',
        version: '1.2.0',
        model: 'openai/gpt-5.6-sol',
        variant: 'high',
        poolSize: 3,
      })
    );

    expect(await globalRow(slug)).toMatchObject({
      displayName: 'Builder',
      description: 'builds',
      origin: 'built_in',
      version: '1.2.0',
      model: 'openai/gpt-5.6-sol',
      variant: 'high',
      tenantId: null,
    });
    expect(await poolSizeOf((await globalRow(slug)).id)).toBe(3);
  });

  it('keeps the row id across boots and mirrors an edited pool size back', async () => {
    const slug = `agent-${randomUUID()}`;
    const entry: AgentRegistryEntry = { name: 'Builder', version: '1.0.0', poolSize: 2 };
    await reconciler.reconcile(registryOf(slug, entry));
    const first = await globalRow(slug);

    await db.update(agentSettings).set({ warmPoolSize: 99 }).where(eq(agentSettings.agentId, first.id));
    await reconciler.reconcile(registryOf(slug, entry));

    const second = await globalRow(slug);
    expect(second.id).toBe(first.id);
    expect(await poolSizeOf(second.id)).toBe(2);
  });

  it('leaves a tenant row with the same slug untouched and adds a global row beside it', async () => {
    const slug = `agent-${randomUUID()}`;
    const tenantRowId = randomUUID();
    await db.insert(agents).values({
      id: tenantRowId,
      name: slug,
      tenantId,
      origin: 'custom',
      createdBy: author,
      version: '9.9.9',
    });
    await db.insert(agentSettings).values({ agentId: tenantRowId, warmPoolSize: 1 });

    await reconciler.reconcile(registryOf(slug, { name: 'Builder', version: '1.0.0', poolSize: 2 }));

    const [tenantRow] = await db.select().from(agents).where(eq(agents.id, tenantRowId));
    expect(tenantRow).toMatchObject({ version: '9.9.9', origin: 'custom' });
    expect(await poolSizeOf(tenantRowId)).toBe(1);
    const global = await globalRow(slug);
    expect(global).toMatchObject({ version: '1.0.0' });
    expect(await poolSizeOf(global.id)).toBe(2);
  });

  it('leaves a slug absent from the registry in place', async () => {
    const retired = `agent-${randomUUID()}`;
    await reconciler.reconcile(registryOf(retired, { name: 'Retired' }));

    await reconciler.reconcile(registryOf(`agent-${randomUUID()}`, { name: 'Fresh' }));

    expect(await globalRow(retired)).toBeDefined();
  });

  it("leaves a Built-in Agent's Resources, set on the platform, alone", async () => {
    const slug = `agent-${randomUUID()}`;
    await reconciler.reconcile(registryOf(slug, { name: 'Builder' }));
    const { id } = await globalRow(slug);
    await db.insert(agentPodSettings).values({
      agentId: id,
      presetId: 'medium',
      cpuMillicores: 1000,
      memoryRequestMib: 4096,
      memoryLimitMib: 8192,
    });

    await reconciler.reconcile(registryOf(slug, { name: 'Builder' }));

    expect(await presetOf(id)).toBe('medium');
  });
});

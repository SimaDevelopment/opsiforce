import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agents, tenants, users } from '../../db/schema';
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

describe('the agent reconciler', () => {
  it('stamps the registry fields on the global row', async () => {
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
      poolSize: 3,
      tenantId: null,
    });
  });

  it('keeps the row id across boots and mirrors an edited pool size back', async () => {
    const slug = `agent-${randomUUID()}`;
    const entry: AgentRegistryEntry = { name: 'Builder', version: '1.0.0', poolSize: 2 };
    await reconciler.reconcile(registryOf(slug, entry));
    const first = await globalRow(slug);

    await db.update(agents).set({ poolSize: 99 }).where(eq(agents.id, first.id));
    await reconciler.reconcile(registryOf(slug, entry));

    const second = await globalRow(slug);
    expect(second.id).toBe(first.id);
    expect(second.poolSize).toBe(2);
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
      poolSize: 7,
      version: '9.9.9',
    });

    await reconciler.reconcile(registryOf(slug, { name: 'Builder', version: '1.0.0', poolSize: 2 }));

    const [tenantRow] = await db.select().from(agents).where(eq(agents.id, tenantRowId));
    expect(tenantRow).toMatchObject({ poolSize: 7, version: '9.9.9', origin: 'custom' });
    expect(await globalRow(slug)).toMatchObject({ poolSize: 2, version: '1.0.0' });
  });

  it('leaves a slug absent from the registry in place', async () => {
    const retired = `agent-${randomUUID()}`;
    await reconciler.reconcile(registryOf(retired, { name: 'Retired' }));

    await reconciler.reconcile(registryOf(`agent-${randomUUID()}`, { name: 'Fresh' }));

    expect(await globalRow(retired)).toBeDefined();
  });
});

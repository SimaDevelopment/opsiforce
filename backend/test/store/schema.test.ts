import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agents, skills, tenants, users } from '../../db/schema';

let tenantA: string;
let tenantB: string;
let author: string;

beforeAll(async () => {
  tenantA = await createTenant();
  tenantB = await createTenant();
  author = await createUser();
});

async function createTenant(): Promise<string> {
  const id = randomUUID();
  await db.insert(tenants).values({ id, name: `org-${id}`, displayName: `Org ${id}` });
  return id;
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, keycloakId: `kc-${id}` });
  return id;
}

async function violatedConstraint(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? String(error);
  }
  throw new Error('the query was accepted');
}

describe('the agents scope indexes', () => {
  it('refuses a second global row with the same name', async () => {
    const name = `agent-${randomUUID()}`;
    await db.insert(agents).values({ id: randomUUID(), name });

    expect(await violatedConstraint(db.insert(agents).values({ id: randomUUID(), name }))).toBe(
      'agents_global_name_unique'
    );
  });

  it('lets one name exist once globally and once per tenant', async () => {
    const name = `agent-${randomUUID()}`;
    await db.insert(agents).values({ id: randomUUID(), name });
    await db.insert(agents).values({ id: randomUUID(), name, tenantId: tenantA, origin: 'custom', createdBy: author });
    await db.insert(agents).values({ id: randomUUID(), name, tenantId: tenantB, origin: 'custom', createdBy: author });

    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name));
    expect(rows).toHaveLength(3);
  });

  it('refuses a second row with the same name inside one tenant', async () => {
    const name = `agent-${randomUUID()}`;
    const row = { name, tenantId: tenantA, origin: 'custom', createdBy: author };
    await db.insert(agents).values({ id: randomUUID(), ...row });

    expect(await violatedConstraint(db.insert(agents).values({ id: randomUUID(), ...row }))).toBe(
      'agents_tenant_id_name_unique'
    );
  });

  it('refuses a custom row with no owner', async () => {
    expect(
      await violatedConstraint(
        db.insert(agents).values({ id: randomUUID(), name: `agent-${randomUUID()}`, origin: 'custom' })
      )
    ).toBe('agents_custom_ownership_check');
  });
});

describe('the skills scope indexes', () => {
  it('refuses a second global row with the same name', async () => {
    const name = `skill-${randomUUID()}`;
    await db.insert(skills).values({ id: randomUUID(), name });

    expect(await violatedConstraint(db.insert(skills).values({ id: randomUUID(), name }))).toBe(
      'skills_global_name_unique'
    );
  });

  it('lets one name exist once globally and once per tenant', async () => {
    const name = `skill-${randomUUID()}`;
    await db.insert(skills).values({ id: randomUUID(), name });
    await db.insert(skills).values({ id: randomUUID(), name, tenantId: tenantA, origin: 'custom', createdBy: author });
    await db.insert(skills).values({ id: randomUUID(), name, tenantId: tenantB, origin: 'custom', createdBy: author });

    const rows = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
    expect(rows).toHaveLength(3);
  });

  it('refuses a second row with the same name inside one tenant', async () => {
    const name = `skill-${randomUUID()}`;
    const row = { name, tenantId: tenantA, origin: 'custom', createdBy: author };
    await db.insert(skills).values({ id: randomUUID(), ...row });

    expect(await violatedConstraint(db.insert(skills).values({ id: randomUUID(), ...row }))).toBe(
      'skills_tenant_id_name_unique'
    );
  });

  it('refuses a custom row with no owner', async () => {
    expect(
      await violatedConstraint(
        db.insert(skills).values({ id: randomUUID(), name: `skill-${randomUUID()}`, origin: 'custom' })
      )
    ).toBe('skills_custom_ownership_check');
  });
});

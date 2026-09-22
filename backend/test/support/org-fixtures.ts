import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { tenants, users } from '../../db/schema';

export async function createTenantRow(name = `org-${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  await db.insert(tenants).values({ id, name, displayName: name });
  return id;
}

export async function createUserRow(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, keycloakId: `kc-${id}` });
  return id;
}

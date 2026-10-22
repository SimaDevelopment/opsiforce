import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { users } from '../../../db/schema';

export async function userIdOf(keycloakId: string | undefined): Promise<string | null> {
  if (!keycloakId) return null;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, keycloakId));
  return user?.id ?? null;
}

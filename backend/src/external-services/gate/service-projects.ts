import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices } from '../../../db/schema';

export async function servesAnExternalService(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: externalServices.id })
    .from(externalServices)
    .where(eq(externalServices.builderChatId, projectId))
    .limit(1);
  return row !== undefined;
}

import { eq, exists } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, projectEnvironments } from '../../../db/schema';

export const servesAnExternalService = exists(
  db
    .select({ id: externalServices.id })
    .from(externalServices)
    .where(eq(externalServices.builderChatId, projectEnvironments.projectId))
).mapWith(Boolean);

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, externalServices, projects } from '../../../db/schema';
import { ensureBuiltInAgent } from '../../support/agent-fixtures';
import type { PersonFixture } from './fixtures';

export const EXTERNAL_SERVICE_BUILDER = 'external-service-builder';
export const TENANT_SERVICES = '/api/external-services/services';

export interface CreatedCustomService {
  id: string;
  slug: string;
  origin: 'custom';
  displayName: string;
  builderChatId: string;
  published: boolean;
}

export function ensureExternalServiceBuilder(): Promise<string> {
  return ensureBuiltInAgent(EXTERNAL_SERVICE_BUILDER);
}

export function postCustomService(app: NestFastifyApplication, person: PersonFixture, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: TENANT_SERVICES,
    headers: person.headers,
    payload: payload as object,
  });
}

export async function createCustomService(
  app: NestFastifyApplication,
  person: PersonFixture,
  name: string,
  slug: string
): Promise<CreatedCustomService> {
  const res = await postCustomService(app, person, { name, slug });
  if (res.statusCode !== 201) throw new Error(`Creating ${slug} answered ${res.statusCode}: ${res.body}`);
  return res.json<CreatedCustomService>();
}

export function renameSlug(app: NestFastifyApplication, person: PersonFixture, id: string, slug: string) {
  return app.inject({
    method: 'PATCH',
    url: `${TENANT_SERVICES}/${id}`,
    headers: person.headers,
    payload: { slug },
  });
}

export async function customServiceRow(id: string) {
  const [row] = await db.select().from(externalServices).where(eq(externalServices.id, id));
  return row;
}

export async function builderProjectRow(chatId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, chatId));
  return row;
}

export async function customServiceRowsOf(tenantId: string) {
  return db.select().from(externalServices).where(eq(externalServices.tenantId, tenantId));
}

export async function markPublished(id: string, tenantId: string): Promise<void> {
  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.tenantId, tenantId))
    .limit(1);
  if (!environment) throw new Error(`Organization ${tenantId} has no environment to publish to`);
  await db.update(externalServices).set({ defaultEnvironmentId: environment.id }).where(eq(externalServices.id, id));
}

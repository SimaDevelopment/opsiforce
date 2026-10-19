import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceConfigs, projectEnvironments } from '../../../db/schema';
import { GatewayKeyService } from '../../../src/gateway/gateway-key.service';
import { ensureBuiltInAgent } from '../../support/agent-fixtures';
import { TENANT_SERVICES } from './custom-services';
import type { PersonFixture } from './fixtures';
import { BOARDS_MANIFEST, writeServiceFiles } from './published-services';

export const BUILDER_LANE = '/api/gateway/_builder';

export const DEVELOPMENT_BOARDS = { apiToken: 'boards-dev-token', apiSecret: 'boards-dev-webhook-secret' };

export const DEVELOPMENT_MANIFEST = { ...BOARDS_MANIFEST, description: 'The board tool, as Development serves it.' };

export interface BuilderDevelopment {
  projectEnvironmentId: string;
  environmentId: string;
  directory: string;
  key: string;
}

/** The builder chat's own Development, running (`yarn dev`) with these files. */
export async function runningDevelopment(
  app: NestFastifyApplication,
  storageRoot: string,
  builderChatId: string,
  manifest: unknown = DEVELOPMENT_MANIFEST
): Promise<BuilderDevelopment> {
  const [environment] = await db
    .update(projectEnvironments)
    .set({ status: 'active', podIp: '127.0.0.1' })
    .where(and(eq(projectEnvironments.projectId, builderChatId), eq(projectEnvironments.isDefault, true)))
    .returning({
      id: projectEnvironments.id,
      environmentId: projectEnvironments.environmentId,
      directory: projectEnvironments.directory,
    });
  if (!environment?.environmentId) throw new Error(`Builder chat ${builderChatId} has no Development`);
  await writeServiceFiles(storageRoot, environment.directory, manifest);
  const key = await app.get(GatewayKeyService).getEnvironmentToken(environment.id);
  if (!key) throw new Error(`Builder chat ${builderChatId} has no service key`);
  return {
    projectEnvironmentId: environment.id,
    environmentId: environment.environmentId,
    directory: environment.directory,
    key,
  };
}

export async function writeDevelopmentSkill(storageRoot: string, directory: string, text: string): Promise<void> {
  await writeFile(join(storageRoot, directory, 'app', 'SKILL.md'), text);
}

interface BuilderLaneRequest {
  method?: 'GET' | 'POST' | 'PUT';
  path?: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

export function builderLane(app: NestFastifyApplication, key: string | null, request: BuilderLaneRequest) {
  return app.inject({
    method: request.method ?? 'GET',
    url: `${BUILDER_LANE}${request.path ?? ''}`,
    headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...request.headers },
    ...(request.payload === undefined ? {} : { payload: request.payload as object }),
  });
}

export interface CreatedTestProject {
  id: string;
  projectEnvironmentId: string;
  agentId: string;
  key: string;
}

export async function createTestProject(app: NestFastifyApplication, builderKey: string): Promise<CreatedTestProject> {
  const agentId = await ensureBuiltInAgent('app-builder');
  const res = await builderLane(app, builderKey, { method: 'POST', path: '/test-project', payload: { agentId } });
  if (res.statusCode !== 201) throw new Error(`Creating the Test Project answered ${res.statusCode}: ${res.body}`);
  const created = res.json<Omit<CreatedTestProject, 'key'>>();
  const key = await app.get(GatewayKeyService).getEnvironmentToken(created.projectEnvironmentId);
  if (!key) throw new Error(`Test Project ${created.id} has no service key`);
  return { ...created, key };
}

export function saveTestProjectConfiguration(
  app: NestFastifyApplication,
  builderKey: string,
  values: Record<string, unknown>
) {
  return builderLane(app, builderKey, { method: 'PUT', path: '/test-project/configuration', payload: { values } });
}

export function developmentRoute(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  request: { method?: 'GET' | 'POST' | 'PUT'; path?: string; payload?: unknown }
) {
  return app.inject({
    method: request.method ?? 'GET',
    url: `${TENANT_SERVICES}/${serviceId}/development${request.path ?? ''}`,
    headers: admin.headers,
    ...(request.payload === undefined ? {} : { payload: request.payload as object }),
  });
}

export function saveDevelopmentConfiguration(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  values: Record<string, unknown>
) {
  return developmentRoute(app, admin, serviceId, { method: 'PUT', path: '/configuration', payload: { values } });
}

export async function storedServiceConfiguration(serviceId: string, environment: 'development' | null) {
  const rows = await db
    .select()
    .from(externalServiceConfigs)
    .where(eq(externalServiceConfigs.externalServiceId, serviceId));
  return rows.find((row) => row.environment === environment)?.values;
}

export async function storeServiceConfigurationRaw(
  serviceId: string,
  tenantId: string,
  environment: 'development' | null,
  values: Record<string, unknown>
): Promise<void> {
  await db
    .insert(externalServiceConfigs)
    .values({ id: crypto.randomUUID(), externalServiceId: serviceId, tenantId, environment, values: values as never })
    .onConflictDoUpdate({
      target: [
        externalServiceConfigs.externalServiceId,
        externalServiceConfigs.tenantId,
        externalServiceConfigs.environment,
      ],
      set: { values: values as never },
    });
}

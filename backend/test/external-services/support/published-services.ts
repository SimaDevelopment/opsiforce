import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, projectEnvironments } from '../../../db/schema';
import { PRODUCTION_ENVIRONMENT_SLUG } from '../../../src/environment/environment.types';
import {
  ProjectConfigurationStore,
  type ProjectConfiguration,
} from '../../../src/external-services/configuration/project-configuration.store';
import { ServiceDefaultEnvironments } from '../../../src/external-services/publishing/service-default-environments';
import { ServiceRegistry, type RegisteredService } from '../../../src/external-services/registry/service-registry';
import { GatewayKeyService } from '../../../src/gateway/gateway-key.service';
import { createProject, serviceKeyFor, type TenantFixture } from '../../support/project-fixtures';
import { createCustomService, TENANT_SERVICES } from './custom-services';
import type { PersonFixture } from './fixtures';
import type { GateCallerFixture } from './gate';

export const BOARDS_MANIFEST = {
  sdk: 2,
  displayName: 'Fixture Boards',
  description: 'A pretend board tool the Organization built itself.',
  inbound: true,
  serviceForm: [
    { key: 'apiToken', type: 'secret', label: 'API token', required: true },
    { key: 'apiSecret', type: 'secret', label: 'Webhook secret' },
  ],
  projectForm: [
    {
      key: 'boardIds',
      type: 'multiselect',
      label: 'Boards',
      options: [
        { value: 'b1', label: 'Roadmap' },
        { value: 'b2', label: 'Operations' },
      ],
    },
  ],
  events: {
    'card.created': { title: 'Card created', description: 'A card was added to a board.' },
  },
} as const;

export const PUBLISHED_COMMIT = 'c0ffee'.padEnd(40, '0');

export const READY_BOARDS = { apiToken: 'boards-token-1', apiSecret: 'boards-webhook-secret' };

export interface PublishedService {
  id: string;
  slug: string;
  tenantId: string;
  builderChatId: string;
  environmentId: string;
  projectEnvironmentId: string;
  directory: string;
  key: string;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function writeServiceFiles(
  storageRoot: string,
  directory: string,
  manifest: unknown,
  options: { sdkVersion?: string; modifiedAt?: Date } = {}
): Promise<void> {
  const folder = join(storageRoot, directory, 'app');
  await mkdir(folder, { recursive: true });
  const manifestPath = join(folder, 'service.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({
      name: 'opsiforce-external-service',
      dependencies: {
        '@opsiforce/external-service-sdk': `file:./vendor/external-service-sdk-${options.sdkVersion ?? '2.0.0'}.tgz`,
      },
    })
  );
  if (options.modifiedAt) await utimes(manifestPath, options.modifiedAt, options.modifiedAt);
}

export async function productionEnvironmentOf(tenantId: string): Promise<string> {
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenantId), eq(environments.slug, PRODUCTION_ENVIRONMENT_SLUG)));
  if (!production) throw new Error(`Organization ${tenantId} has no Production environment`);
  return production.id;
}

export async function addServiceEnvironment(
  app: INestApplication,
  builderChatId: string,
  tenantId: string,
  environmentId: string
): Promise<{ projectEnvironmentId: string; directory: string; key: string }> {
  const projectEnvironmentId = crypto.randomUUID();
  const directory = `projects/${projectEnvironmentId}`;
  await db.insert(projectEnvironments).values({
    id: projectEnvironmentId,
    projectId: builderChatId,
    environmentId,
    isDefault: false,
    directory,
    platformVersion: '0.0.0-test',
    status: 'active',
    podIp: '127.0.0.1',
    deployedCommitSha: PUBLISHED_COMMIT,
  });
  const key = await app.get(GatewayKeyService).createKey(builderChatId, projectEnvironmentId, tenantId);
  return { projectEnvironmentId, directory, key };
}

export async function publishCustomService(
  app: NestFastifyApplication,
  admin: PersonFixture,
  storageRoot: string,
  options: { slug: string; name?: string; manifest?: unknown }
): Promise<PublishedService> {
  const created = await createCustomService(app, admin, options.name ?? 'Boards', options.slug);
  const environmentId = await productionEnvironmentOf(admin.tenant.tenantId);
  const environment = await addServiceEnvironment(app, created.builderChatId, admin.tenant.tenantId, environmentId);
  await writeServiceFiles(storageRoot, environment.directory, options.manifest ?? BOARDS_MANIFEST);
  await app.get(ServiceDefaultEnvironments).publishedTo(created.builderChatId, environment.projectEnvironmentId);
  return {
    id: created.id,
    slug: created.slug,
    tenantId: admin.tenant.tenantId,
    builderChatId: created.builderChatId,
    environmentId,
    ...environment,
  };
}

export function saveCustomServiceConfiguration(
  app: NestFastifyApplication,
  admin: PersonFixture,
  id: string,
  values: Record<string, unknown>
) {
  return app.inject({
    method: 'PUT',
    url: `${TENANT_SERVICES}/${id}/configuration`,
    headers: admin.headers,
    payload: { values },
  });
}

export async function consumerIn(app: INestApplication, tenant: TenantFixture): Promise<GateCallerFixture> {
  const projectTitle = `consumer-${crypto.randomUUID().slice(0, 8)}`;
  const projectId = await createProject(app, tenant, { title: projectTitle });
  return {
    tenant,
    projectId,
    projectTitle,
    projectEnvironmentId: projectId,
    key: await serviceKeyFor(app, tenant, projectId),
  };
}

export async function callableService(
  app: INestApplication,
  tenantId: string,
  slug: string
): Promise<RegisteredService> {
  const service = (await app.get(ServiceRegistry).listForTenant(tenantId)).find((candidate) => candidate.slug === slug);
  if (!service) throw new Error(`No External Service ${slug} for Organization ${tenantId}`);
  return service;
}

export async function saveConsumerConfiguration(
  app: INestApplication,
  consumer: GateCallerFixture,
  slug: string,
  values: Record<string, unknown>
): Promise<ProjectConfiguration> {
  const service = await callableService(app, consumer.tenant.tenantId, slug);
  return app.get(ProjectConfigurationStore).save(service, consumer.projectEnvironmentId, values);
}

export async function suspendServicePod(projectEnvironmentId: string): Promise<void> {
  await db
    .update(projectEnvironments)
    .set({ status: 'suspended', podIp: null })
    .where(eq(projectEnvironments.id, projectEnvironmentId));
}

export async function serviceEnvironmentRow(projectEnvironmentId: string) {
  const [row] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.id, projectEnvironmentId));
  return row;
}

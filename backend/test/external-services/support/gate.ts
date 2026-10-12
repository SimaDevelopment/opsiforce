import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  environments,
  externalServiceCalls,
  externalServiceProjectConfigs,
  projectEnvironments,
  type JsonValue,
} from '../../../db/schema';
import { PLATFORM_OWNER } from '../../../src/external-services/configuration/configuration-values';
import {
  ProjectConfigurationStore,
  type ProjectConfiguration,
} from '../../../src/external-services/configuration/project-configuration.store';
import { ServiceConfigurationStore } from '../../../src/external-services/configuration/service-configuration.store';
import { ServicePods } from '../../../src/external-services/gate/service-pods';
import { ServiceRegistry, type RegisteredService } from '../../../src/external-services/registry/service-registry';
import { startFakeServicePod, type FakeServicePod } from './fake-service-pod';
import { PRODUCTION_ENVIRONMENT_SLUG } from '../../../src/environment/environment.types';
import { GatewayKeyService } from '../../../src/gateway/gateway-key.service';
import { createProject, createTenant, serviceKeyFor, type TenantFixture } from '../../support/project-fixtures';
import { fixtureBuiltInsDir } from './app';
import { builtInServiceId } from './fixtures';

export interface GateCallerFixture {
  tenant: TenantFixture;
  projectId: string;
  projectTitle: string;
  projectEnvironmentId: string;
  key: string;
}

export const READY_FIXTURE_CRM = {
  baseUrl: 'https://crm.example.com',
  region: 'eu',
  apiKey: 'crm-key-1',
  mailboxes: [
    { label: 'Support', token: 'support-token' },
    { label: 'Sales', token: 'sales-token' },
  ],
};

function registered(app: INestApplication, slug: string): RegisteredService {
  const service = app.get(ServiceRegistry).bySlug(slug);
  if (!service) throw new Error(`No registered External Service ${slug}`);
  return service;
}

export async function gateCaller(app: INestApplication): Promise<GateCallerFixture> {
  const tenant = await createTenant(app);
  const projectTitle = `gate-${crypto.randomUUID().slice(0, 8)}`;
  const projectId = await createProject(app, tenant, { title: projectTitle });
  return {
    tenant,
    projectId,
    projectTitle,
    projectEnvironmentId: projectId,
    key: await serviceKeyFor(app, tenant, projectId),
  };
}

export async function configurePlatformService(
  app: INestApplication,
  slug: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const saved = await app.get(ServiceConfigurationStore).saveAndReport(registered(app, slug), PLATFORM_OWNER, values);
  return saved.current.values;
}

export function mailboxIds(serviceConfiguration: Record<string, unknown>): string[] {
  return (serviceConfiguration.mailboxes as { id: string }[]).map((mailbox) => mailbox.id);
}

export function saveProjectConfiguration(
  app: INestApplication,
  slug: string,
  projectEnvironmentId: string,
  values: Record<string, unknown>
): Promise<ProjectConfiguration> {
  return app.get(ProjectConfigurationStore).save(registered(app, slug), projectEnvironmentId, values);
}

export function readProjectConfiguration(
  app: INestApplication,
  slug: string,
  projectEnvironmentId: string
): Promise<ProjectConfiguration> {
  return app.get(ProjectConfigurationStore).read(registered(app, slug), projectEnvironmentId);
}

export async function storeProjectConfiguration(
  slug: string,
  projectEnvironmentId: string,
  values: Record<string, JsonValue>
): Promise<void> {
  await db
    .insert(externalServiceProjectConfigs)
    .values({
      id: crypto.randomUUID(),
      externalServiceId: await builtInServiceId(slug),
      projectEnvironmentId,
      values,
    })
    .onConflictDoUpdate({
      target: [externalServiceProjectConfigs.externalServiceId, externalServiceProjectConfigs.projectEnvironmentId],
      set: { values },
    });
}

export async function storedProjectConfiguration(
  slug: string,
  projectEnvironmentId: string
): Promise<Record<string, JsonValue> | null> {
  const rows = await db
    .select({
      values: externalServiceProjectConfigs.values,
      serviceId: externalServiceProjectConfigs.externalServiceId,
    })
    .from(externalServiceProjectConfigs)
    .where(eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId));
  const serviceId = await builtInServiceId(slug);
  return rows.find((row) => row.serviceId === serviceId)?.values ?? null;
}

export function callOperation(
  app: NestFastifyApplication,
  options: {
    key?: string;
    slug: string;
    operation: string;
    input?: unknown;
    headers?: Record<string, string>;
  }
) {
  return app.inject({
    method: 'POST',
    url: `/api/external-services/agent/${options.slug}/${options.operation}`,
    headers: {
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...options.headers,
    },
    payload: (options.input ?? {}) as Record<string, unknown>,
  });
}

export type CallRow = typeof externalServiceCalls.$inferSelect;

export async function callRow(callId: string): Promise<CallRow | undefined> {
  const [row] = await db.select().from(externalServiceCalls).where(eq(externalServiceCalls.id, callId));
  return row;
}

export function callRowsOf(projectEnvironmentId: string): Promise<CallRow[]> {
  return db
    .select()
    .from(externalServiceCalls)
    .where(eq(externalServiceCalls.projectEnvironmentId, projectEnvironmentId))
    .orderBy(desc(externalServiceCalls.createdAt));
}

export function fixtureManifest(slug: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureBuiltInsDir, slug, 'service.json'), 'utf8')) as Record<string, unknown>;
}

export interface ServicePodFixture {
  pod: FakeServicePod;
  projectEnvironmentId: string;
  key: string;
  stop: () => Promise<void>;
}

export async function servicePodEnvironment(
  app: INestApplication
): Promise<{ projectEnvironmentId: string; key: string }> {
  const tenant = await createTenant(app);
  const projectId = await createProject(app, tenant, { title: `service-pod-${crypto.randomUUID().slice(0, 8)}` });
  return { projectEnvironmentId: projectId, key: await serviceKeyFor(app, tenant, projectId) };
}

export async function dispatchToFakePod(
  app: INestApplication,
  slug: string,
  options: { manifest?: Record<string, unknown>; projectEnvironmentId?: string } = {}
): Promise<ServicePodFixture> {
  const environment = await servicePodEnvironment(app);
  const pod = await startFakeServicePod({
    manifest: options.manifest ?? fixtureManifest(slug),
    gatewayKey: environment.key,
  });
  const stopServing = app.get(ServicePods).serve(registered(app, slug).id, {
    url: pod.url,
    projectEnvironmentId: options.projectEnvironmentId ?? environment.projectEnvironmentId,
  });
  return {
    pod,
    ...environment,
    stop: async () => {
      stopServing();
      await pod.close();
    },
  };
}

export async function productionCaller(app: INestApplication, caller: GateCallerFixture): Promise<GateCallerFixture> {
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, caller.tenant.tenantId), eq(environments.slug, PRODUCTION_ENVIRONMENT_SLUG)));
  if (!production) throw new Error(`Organization ${caller.tenant.name} has no Production environment`);
  const projectEnvironmentId = crypto.randomUUID();
  await db.insert(projectEnvironments).values({
    id: projectEnvironmentId,
    projectId: caller.projectId,
    environmentId: production.id,
    isDefault: false,
    directory: `projects/${projectEnvironmentId}`,
    platformVersion: '0.0.0-test',
    status: 'active',
  });
  return {
    ...caller,
    projectEnvironmentId,
    key: await app.get(GatewayKeyService).createKey(caller.projectId, projectEnvironmentId, caller.tenant.tenantId),
  };
}

export function askGate(
  app: NestFastifyApplication,
  options: { key?: string; path: string; headers?: Record<string, string> }
) {
  return app.inject({
    method: 'GET',
    url: `/api/external-services/agent/${options.path}`,
    headers: {
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...options.headers,
    },
  });
}

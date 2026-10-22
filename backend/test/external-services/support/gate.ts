import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, externalServiceProjectConfigs, projectEnvironments, type JsonValue } from '../../../db/schema';
import { PLATFORM_OWNER } from '../../../src/external-services/configuration/configuration-values';
import {
  ProjectConfigurationStore,
  type ProjectConfiguration,
} from '../../../src/external-services/configuration/project-configuration.store';
import { ServiceConfigurationStore } from '../../../src/external-services/configuration/service-configuration.store';
import { ServiceRegistry, type RegisteredService } from '../../../src/external-services/registry/service-registry';
import { PRODUCTION_ENVIRONMENT_SLUG } from '../../../src/environment/environment.types';
import { GatewayKeyService } from '../../../src/gateway/gateway-key.service';
import { createProject, createTenant, serviceKeyFor, type TenantFixture } from '../../support/project-fixtures';
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

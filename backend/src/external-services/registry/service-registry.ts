import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { DefinedService, ServiceManifest } from '@opsiforce/external-service-sdk';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, type ExternalServiceOriginValue } from '../../../db/schema';
import { BUILT_IN_SERVICES_DIR, readBuiltInServices, type BuiltInServiceFolder } from './built-in-services';
import { CustomServiceCatalog, servableOrNone, type ServiceHome, type TestedService } from './custom-service-catalog';

export interface RegisteredService {
  id: string;
  slug: string;
  origin: ExternalServiceOriginValue;
  tenantId: string | null;
  manifest: ServiceManifest;
  manifestHash: string;
  icon: string | null;
  serviceSkill: string | null;
  defined: DefinedService | null;
  home: ServiceHome | null;
}

async function builtInRowId(slug: string): Promise<string> {
  await db.insert(externalServices).values({ id: crypto.randomUUID(), origin: 'built_in', slug }).onConflictDoNothing();
  const [row] = await db
    .select({ id: externalServices.id })
    .from(externalServices)
    .where(and(eq(externalServices.slug, slug), isNull(externalServices.tenantId)));
  if (!row) throw new Error(`The built-in External Service ${slug} has no row after its upsert`);
  return row.id;
}

@Injectable()
export class ServiceRegistry implements OnModuleInit {
  private services: RegisteredService[] = [];

  constructor(
    @Inject(BUILT_IN_SERVICES_DIR) private readonly builtInsDir: string,
    private readonly customs: CustomServiceCatalog
  ) {}

  async onModuleInit(): Promise<void> {
    const folders = await readBuiltInServices(this.builtInsDir);
    this.services = await Promise.all(folders.map((folder) => this.register(folder)));
  }

  list(): readonly RegisteredService[] {
    return this.services;
  }

  byId(id: string): RegisteredService | undefined {
    return this.services.find((service) => service.id === id);
  }

  bySlug(slug: string): RegisteredService | undefined {
    return this.services.find((service) => service.slug === slug);
  }

  async webhookTarget(slugOrId: string): Promise<RegisteredService | null> {
    return this.bySlug(slugOrId) ?? this.customs.byId(slugOrId);
  }

  private async forTenant(tenantId: string, slug: string): Promise<RegisteredService | undefined> {
    const own = await this.customs.bySlug(tenantId, slug);
    if (own) return own;
    if ((await this.customs.slugsOf(tenantId)).has(slug)) return undefined;
    return this.bySlug(slug);
  }

  async forEnvironment(
    tenantId: string,
    projectEnvironmentId: string,
    slug: string
  ): Promise<RegisteredService | undefined> {
    const tested = await this.testedBy(projectEnvironmentId, tenantId);
    if (tested?.slug === slug) return (await this.customs.development(tested.id)) ?? undefined;
    return this.forTenant(tenantId, slug);
  }

  async listForEnvironment(tenantId: string, projectEnvironmentId: string): Promise<RegisteredService[]> {
    const services = await this.listForTenant(tenantId);
    const tested = await this.testedBy(projectEnvironmentId, tenantId);
    const development = tested ? await servableOrNone(this.customs.development(tested.id)) : null;
    if (!development) return services;
    return [...services.filter((service) => service.id !== development.id), development];
  }

  async byIdForEnvironment(projectEnvironmentId: string, id: string): Promise<RegisteredService | undefined> {
    const tested = await this.testedBy(projectEnvironmentId);
    if (tested?.id === id) return (await this.customs.development(id)) ?? undefined;
    return this.byId(id) ?? (await this.customs.byId(id)) ?? undefined;
  }

  development(id: string): Promise<RegisteredService | null> {
    return this.customs.development(id);
  }

  async testedBy(projectEnvironmentId: string, tenantId?: string): Promise<TestedService | null> {
    const tested = await this.customs.testedBy(projectEnvironmentId);
    return tested && (tenantId === undefined || tested.tenantId === tenantId) ? tested : null;
  }

  async listForTenant(tenantId: string): Promise<RegisteredService[]> {
    const hidden = await this.customs.slugsOf(tenantId);
    return [
      ...this.services.filter((service) => !hidden.has(service.slug)),
      ...(await this.customs.listPublished(tenantId)),
    ];
  }

  async byIdForTenant(tenantId: string, id: string): Promise<RegisteredService | undefined> {
    const builtIn = this.byId(id);
    if (builtIn) return (await this.customs.slugsOf(tenantId)).has(builtIn.slug) ? undefined : builtIn;
    const custom = await servableOrNone(this.customs.byId(id));
    return custom?.tenantId === tenantId ? custom : undefined;
  }

  publishedAt(id: string, environmentId: string): Promise<RegisteredService | null> {
    return this.customs.publishedAt(id, environmentId);
  }

  publishedCustom(id: string): Promise<RegisteredService | null> {
    return this.customs.byId(id);
  }

  private idOf(slug: string): string {
    const service = this.bySlug(slug);
    if (!service) throw new Error(`The built-in External Service ${slug} is not registered`);
    return service.id;
  }

  private async register(folder: BuiltInServiceFolder): Promise<RegisteredService> {
    return {
      id: await builtInRowId(folder.slug),
      slug: folder.slug,
      origin: 'built_in',
      tenantId: null,
      manifest: folder.manifest,
      manifestHash: folder.manifestHash,
      icon: folder.icon,
      serviceSkill: folder.serviceSkill,
      defined: folder.defined,
      home: null,
    };
  }
}

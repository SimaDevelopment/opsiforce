import { ConflictException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { db } from '../../../db';
import { environments, type ExternalServiceOriginValue } from '../../../db/schema';
import { CustomServiceRepository, type CustomServiceRow } from '../custom/custom-service.repository';
import { sdkStatusOf, type SdkStatus } from '../publishing/sdk-status';
import type { HookFailure } from '../gate/hook-calls';
import { servableOrNone, UnservableCustomService } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import {
  callersOwner,
  masked,
  PLATFORM_OWNER,
  type ConfigurationOwner,
  type ConfigurationValues,
} from './configuration-values';
import { ConfigurationSaves } from './configuration-saves';
import { isAvailable, ServiceAvailability } from './service-availability';
import type { RevealedSecret } from './generated-values';
import { rotationTarget } from './rotation';
import { serviceWebhookUrl } from './webhook-url';
import { ServiceConfigurationSaveHooks } from './service-configuration-save-hooks';
import { ServiceConfigurationStore, type ServiceConfigurationSave } from './service-configuration.store';
import type { TolerantRead } from './tolerant-read';

export interface ServiceSummary {
  id: string;
  slug: string;
  origin: ExternalServiceOriginValue;
  displayName: string;
  description: string;
  icon: string | null;
}

export interface OperatorServiceSummary extends ServiceSummary {
  available: boolean;
}

export interface OperatorServiceView extends OperatorServiceSummary {
  manifest: ServiceManifest;
  serviceSkill: string | null;
  webhookUrl: string | null;
  serviceConfiguration: { values: ConfigurationValues; missing: string[] };
  hookFailure: HookFailure | null;
}

export interface SavedOperatorServiceView extends OperatorServiceView {
  revealed: RevealedSecret[];
}

export interface DevelopmentServiceView extends ServiceSummary {
  manifest: ServiceManifest;
  webhookUrl: string | null;
  serviceConfiguration: { values: ConfigurationValues; missing: string[] };
  saved: boolean;
  production: { saved: boolean };
  hookFailure: HookFailure | null;
  revealed?: RevealedSecret[];
}

export interface TenantServiceView extends ServiceSummary {
  manifest: Omit<ServiceManifest, 'serviceForm'>;
  serviceSkill: string | null;
}

export interface NamedEnvironment {
  environmentId: string;
  name: string;
}

export interface CustomServiceView extends OperatorServiceView {
  builderChatId: string;
  published: true;
  disabled: boolean;
  sdkVersion: string | null;
  sdk: SdkStatus;
  defaultEnvironment: NamedEnvironment | null;
  hidesBuiltIn: boolean;
}

export interface UncallableCustomServiceView extends ServiceSummary {
  origin: 'custom';
  builderChatId: string;
  published: boolean;
  disabled: boolean;
  hidesBuiltIn: boolean;
  sdk: SdkStatus;
  defaultEnvironment: NamedEnvironment | null;
  manifest: ServiceManifest | null;
  serviceSkill: string | null;
  builtOnSdk1: boolean;
}

export interface SavedCustomServiceView extends CustomServiceView {
  revealed: RevealedSecret[];
}

type WithRevealed<View> = View & { revealed: RevealedSecret[] };

interface ConfiguredService<View> {
  service: RegisteredService;
  owner: ConfigurationOwner;
  viewOf: (read: TolerantRead, hookFailure: HookFailure | null) => Promise<View>;
}

type ConfiguredServiceLookup<View> = ConfiguredService<View> | Promise<ConfiguredService<View>>;

export function summaryOf(service: RegisteredService): ServiceSummary {
  return {
    id: service.id,
    slug: service.slug,
    origin: service.origin,
    displayName: service.manifest.displayName,
    description: service.manifest.description,
    icon: service.icon,
  };
}

function operatorViewOf(
  service: RegisteredService,
  read: TolerantRead,
  webhookUrl: string | null,
  hookFailure: HookFailure | null
): OperatorServiceView {
  return {
    hookFailure,
    ...summaryOf(service),
    available: isAvailable(read),
    manifest: service.manifest,
    serviceSkill: service.serviceSkill,
    webhookUrl,
    serviceConfiguration: {
      values: masked(service.manifest.serviceForm ?? [], read.values),
      missing: read.missing,
    },
  };
}

function customViewOf(
  service: RegisteredService,
  read: TolerantRead,
  webhookUrl: string | null,
  hidesBuiltIn: boolean,
  hookFailure: HookFailure | null,
  defaultEnvironment: NamedEnvironment | null
): CustomServiceView {
  return {
    hidesBuiltIn,
    ...operatorViewOf(service, read, webhookUrl, hookFailure),
    builderChatId: service.home?.builderChatId ?? '',
    published: true,
    disabled: service.home?.disabled ?? false,
    sdkVersion: service.home?.sdkVersion ?? null,
    sdk: sdkStatusOf(service.home?.sdkVersion ?? null),
    defaultEnvironment,
  };
}

async function namedEnvironment(environmentId: string | null | undefined): Promise<NamedEnvironment | null> {
  if (!environmentId) return null;
  const [environment] = await db
    .select({ environmentId: environments.id, name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return environment ?? null;
}

function uncallableViewOf(
  row: CustomServiceRow,
  development: RegisteredService | null,
  builtOnSdk1: boolean,
  hidesBuiltIn: boolean,
  defaultEnvironment: NamedEnvironment | null
): UncallableCustomServiceView {
  return {
    id: row.id,
    slug: row.slug,
    origin: 'custom',
    displayName: development?.manifest.displayName ?? row.name,
    description: development?.manifest.description ?? '',
    icon: development?.icon ?? null,
    builderChatId: row.builderChatId,
    published: row.defaultEnvironmentId !== null,
    disabled: row.disabled,
    hidesBuiltIn,
    sdk: sdkStatusOf(development?.home?.sdkVersion ?? null),
    defaultEnvironment,
    manifest: development?.manifest ?? null,
    serviceSkill: development?.serviceSkill ?? null,
    builtOnSdk1,
  };
}

function tenantViewOf(service: RegisteredService): TenantServiceView {
  const { serviceForm: _serviceForm, ...manifest } = service.manifest;
  return { ...summaryOf(service), manifest, serviceSkill: service.serviceSkill };
}

@Injectable()
export class ServiceViews implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServiceViews.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly store: ServiceConfigurationStore,
    private readonly availability: ServiceAvailability,
    private readonly config: ConfigService,
    private readonly saveHooks: ServiceConfigurationSaveHooks,
    private readonly saves: ConfigurationSaves,
    private readonly customServices: CustomServiceRepository
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const services = this.registry.list();
    const reads = await this.store.readAll(services, PLATFORM_OWNER);
    for (const service of services) {
      const missing = reads.get(service.id)?.missing ?? [];
      if (missing.length > 0) {
        this.logger.warn(`Built-in External Service ${service.slug} needs setup; missing: ${missing.join(', ')}`);
      }
    }
  }

  async operatorList(): Promise<OperatorServiceSummary[]> {
    const services = this.registry.list();
    const reads = await this.store.readAll(services, PLATFORM_OWNER);
    return services.map((service) =>
      Object.assign(summaryOf(service), { available: isAvailable(reads.get(service.id)) })
    );
  }

  async operatorView(id: string): Promise<OperatorServiceView> {
    return this.read(this.platformService(id));
  }

  async saveServiceConfiguration(id: string, values: unknown): Promise<SavedOperatorServiceView> {
    return this.save(this.platformService(id), values);
  }

  async rotateServiceConfiguration(id: string, target: unknown): Promise<SavedOperatorServiceView> {
    return this.rotate(this.platformService(id), target);
  }

  async retryServiceConfigurationHook(id: string): Promise<OperatorServiceView> {
    return this.retry(this.platformService(id));
  }

  discardServiceConfigurationHook(id: string): Promise<OperatorServiceView> {
    return this.discardHook(this.platformService(id));
  }

  async tenantList(tenantId: string): Promise<TenantServiceView[]> {
    return (await this.availableBuiltIns(tenantId)).map(tenantViewOf);
  }

  async tenantView(
    tenantId: string,
    id: string,
    managesCustomServices: boolean
  ): Promise<TenantServiceView | CustomServiceView | UncallableCustomServiceView> {
    const builtIn = (await this.availableBuiltIns(tenantId)).find((candidate) => candidate.id === id);
    if (builtIn) return tenantViewOf(builtIn);
    if (!managesCustomServices) throw new NotFoundException(`No External Service ${id}`);
    const custom = await this.ownCustomService(tenantId, id);
    if (!custom) return this.uncallableView(tenantId, id);
    return this.read(this.configuredCustom(custom));
  }

  saveCustomServiceConfiguration(tenantId: string, id: string, values: unknown): Promise<SavedCustomServiceView> {
    return this.save(this.customService(tenantId, id), values);
  }

  rotateCustomServiceConfiguration(tenantId: string, id: string, target: unknown): Promise<SavedCustomServiceView> {
    return this.rotate(this.customService(tenantId, id), target);
  }

  retryCustomServiceConfigurationHook(tenantId: string, id: string): Promise<CustomServiceView> {
    return this.retry(this.customService(tenantId, id));
  }

  discardCustomServiceConfigurationHook(tenantId: string, id: string): Promise<CustomServiceView> {
    return this.discardHook(this.customService(tenantId, id));
  }

  developmentView(tenantId: string, id: string): Promise<DevelopmentServiceView> {
    return this.read(this.developmentService(tenantId, id));
  }

  saveDevelopmentConfiguration(tenantId: string, id: string, values: unknown): Promise<DevelopmentServiceView> {
    return this.save(this.developmentService(tenantId, id), values);
  }

  rotateDevelopmentConfiguration(tenantId: string, id: string, target: unknown): Promise<DevelopmentServiceView> {
    return this.rotate(this.developmentService(tenantId, id), target);
  }

  retryDevelopmentConfigurationHook(tenantId: string, id: string): Promise<DevelopmentServiceView> {
    return this.retry(this.developmentService(tenantId, id));
  }

  discardDevelopmentConfigurationHook(tenantId: string, id: string): Promise<DevelopmentServiceView> {
    return this.discardHook(this.developmentService(tenantId, id));
  }

  async copyProductionToDevelopment(tenantId: string, id: string): Promise<DevelopmentServiceView> {
    const { service, owner, viewOf } = await this.developmentService(tenantId, id);
    const saved = await this.saves.service(service, owner, async () => {
      const copied = await this.store.copy(service, callersOwner({ tenantId }), owner);
      if (!copied) {
        throw new ConflictException({
          code: 'nothing-to-copy',
          message: 'The configuration callers use has not been saved yet, so there is nothing to copy.',
        });
      }
      return copied;
    });
    return viewOf(saved.current, saved.hookFailure);
  }

  private async read<View>(lookup: ConfiguredServiceLookup<View>): Promise<View> {
    const { service, owner, viewOf } = await lookup;
    return viewOf(await this.store.read(service, owner), await this.saveHooks.failureOf(service, owner));
  }

  private async save<View>(lookup: ConfiguredServiceLookup<View>, values: unknown): Promise<WithRevealed<View>> {
    const configured = await lookup;
    const { service, owner } = configured;
    return this.savedView(configured, () => this.store.saveAndReport(service, owner, values));
  }

  private async rotate<View>(lookup: ConfiguredServiceLookup<View>, target: unknown): Promise<WithRevealed<View>> {
    const configured = await lookup;
    const { service, owner } = configured;
    const current = await this.store.read(service, owner);
    const rotate = rotationTarget(service.manifest.serviceForm ?? [], current.values, target);
    return this.savedView(configured, () => this.store.saveAndReport(service, owner, current.values, { rotate }));
  }

  private async retry<View>(lookup: ConfiguredServiceLookup<View>): Promise<View> {
    const { service, owner, viewOf } = await lookup;
    const hookFailure = await this.saveHooks.retry(service, owner);
    return viewOf(await this.store.read(service, owner), hookFailure);
  }

  private async discardHook<View>(lookup: ConfiguredServiceLookup<View>): Promise<View> {
    const { service, owner, viewOf } = await lookup;
    await this.saveHooks.discard(service, owner);
    return viewOf(await this.store.read(service, owner), null);
  }

  private async savedView<View>(
    { service, owner, viewOf }: ConfiguredService<View>,
    save: () => Promise<ServiceConfigurationSave>
  ): Promise<WithRevealed<View>> {
    const saved = await this.saves.service(service, owner, save);
    return { ...(await viewOf(saved.current, saved.hookFailure)), revealed: saved.revealed };
  }

  private platformService(id: string): ConfiguredService<OperatorServiceView> {
    const service = this.known(id);
    return {
      service,
      owner: PLATFORM_OWNER,
      viewOf: async (read, hookFailure) => operatorViewOf(service, read, this.webhookUrlOf(service), hookFailure),
    };
  }

  private async customService(tenantId: string, id: string): Promise<ConfiguredService<CustomServiceView>> {
    const custom = await this.ownCustomService(tenantId, id);
    if (!custom) throw new NotFoundException(`No External Service ${id}`);
    return this.configuredCustom(custom);
  }

  private configuredCustom(custom: RegisteredService): ConfiguredService<CustomServiceView> {
    return {
      service: custom,
      owner: callersOwner(custom),
      viewOf: async (read, hookFailure) =>
        customViewOf(
          custom,
          read,
          this.webhookUrlOf(custom),
          this.isBuiltInSlug(custom.slug),
          hookFailure,
          await namedEnvironment(custom.home?.environmentId)
        ),
    };
  }

  private async developmentService(tenantId: string, id: string): Promise<ConfiguredService<DevelopmentServiceView>> {
    const development = await this.ownDevelopment(tenantId, id);
    return {
      service: development,
      owner: callersOwner(development),
      viewOf: async (read, hookFailure) => {
        const stored = await this.store.storedEnvironments(development);
        return {
          ...summaryOf(development),
          manifest: development.manifest,
          webhookUrl: this.webhookUrlOf(development),
          serviceConfiguration: {
            values: masked(development.manifest.serviceForm ?? [], read.values),
            missing: read.missing,
          },
          saved: stored.includes('development'),
          production: { saved: stored.includes(null) },
          hookFailure,
        };
      },
    };
  }

  private async uncallableView(tenantId: string, id: string): Promise<UncallableCustomServiceView> {
    const row = await this.customServices.findInTenant(tenantId, id);
    if (!row) throw new NotFoundException(`No External Service ${id}`);
    let builtOnSdk1 = false;
    const development = await servableOrNone(this.registry.development(id), (error) => {
      builtOnSdk1 = error.builtOnSdk1;
    });
    return uncallableViewOf(
      row,
      development,
      builtOnSdk1,
      this.isBuiltInSlug(row.slug),
      await namedEnvironment(row.defaultEnvironmentId)
    );
  }

  private async ownDevelopment(tenantId: string, id: string): Promise<RegisteredService> {
    let development: RegisteredService | null;
    try {
      development = await this.registry.development(id);
    } catch (error) {
      if (!(error instanceof UnservableCustomService)) throw error;
      throw new ConflictException({
        code: 'development-unservable',
        message: `Development's files cannot be read yet: ${error.message}`,
      });
    }
    if (!development || development.tenantId !== tenantId) throw new NotFoundException(`No External Service ${id}`);
    return development;
  }

  private async ownCustomService(tenantId: string, id: string): Promise<RegisteredService | undefined> {
    const service = await this.registry.byIdForTenant(tenantId, id);
    return service?.origin === 'custom' ? service : undefined;
  }

  private async availableBuiltIns(tenantId: string): Promise<RegisteredService[]> {
    return (await this.availability.availableToTenant(tenantId)).filter((service) => service.origin === 'built_in');
  }

  private isBuiltInSlug(slug: string): boolean {
    return this.registry.bySlug(slug) !== undefined;
  }

  private webhookUrlOf(service: RegisteredService): string | null {
    return serviceWebhookUrl(this.config, service);
  }

  private known(id: string): RegisteredService {
    const service = this.registry.byId(id);
    if (!service) throw new NotFoundException(`No External Service ${id}`);
    return service;
  }
}

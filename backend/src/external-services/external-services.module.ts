import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceSkillSource } from '../delivery/service-skill-source';
import { ServiceSkillAvailability } from '../store/service-skill-availability';
import { ServiceSwitchCatalog } from '../store/service-switch-catalog';
import { GatewayModule } from '../gateway/gateway.module';
import { ProjectEnvironmentModule } from '../project-environment/project-environment.module';
import { SealingModule } from '../sealing/sealing.module';
import { CallLogReader } from './calls/call-log-reader';
import { ConfigurationDelivery } from './configuration/configuration-delivery';
import { ConfigurationSaves } from './configuration/configuration-saves';
import { GeneratedValueBackfill } from './configuration/generated-value-backfill';
import { GeneratedValueSource } from './configuration/generated-values';
import { OperationSwitches } from './configuration/operation-switches';
import { PendingHooks } from './configuration/pending-hooks';
import { ServiceConfigurationSaveHooks } from './configuration/service-configuration-save-hooks';
import { ProjectConfigurationCarry } from './configuration/project-configuration-carry';
import { ProjectConfigurationSaveHooks } from './configuration/project-configuration-save-hooks';
import { ProjectConfigurationStore } from './configuration/project-configuration.store';
import { ProjectServiceViews } from './configuration/project-service-views';
import { ServiceAvailability } from './configuration/service-availability';
import { ServiceConfigurationStore } from './configuration/service-configuration.store';
import { ServiceConsumers } from './configuration/service-consumers';
import { ServiceViews } from './configuration/service-views';
import { CustomServiceRepository } from './custom/custom-service.repository';
import { Doorbell } from './doorbell/doorbell';
import { CallLog } from './gate/call-log';
import { ExternalServiceGate } from './gate/external-service-gate';
import { FormCalls } from './gate/form-calls';
import { GateCallers } from './gate/gate-caller';
import { GateSurfaces } from './gate/gate-surfaces';
import { HookCalls } from './gate/hook-calls';
import { EventReceivers } from './inbound/event-receivers';
import { InboundPipeline } from './inbound/inbound-pipeline';
import { ExternalServiceGateController } from './gate/gate.controller';
import { DefaultLaneHolds, SERVICE_SWITCH_DRAIN, SERVICE_SWITCH_DRAIN_MS } from './gate/default-lane-holds';
import { ServiceDispatcher } from './gate/service-dispatcher';
import { SERVICE_POD_PORT, SERVICE_START_HOLD, SERVICE_START_HOLD_MS, ServicePods } from './gate/service-pods';
import { TenantServicesController } from './http/tenant-services.controller';
import { PlatformServicesController } from './http/platform-services.controller';
import { ProjectServicesController } from './http/project-services.controller';
import { WebhooksController } from './http/webhooks.controller';
import { ServiceSkillReach } from './knowledge/service-skill-reach';
import { ServiceSkillVersions } from './knowledge/service-skill-versions';
import { ServiceSkills } from './knowledge/service-skills';
import { ConfigurationsAtCreate } from './test-lane/configurations-at-create';
import { ServiceStateFiles } from './custom/service-state-files';
import { ExternalServiceStore } from './inbound/external-service-store';
import { BUILT_IN_SERVICES_DIR, shippedBuiltInServicesDir } from './registry/built-in-services';
import { CustomServiceCatalog } from './registry/custom-service-catalog';
import { PublishedServiceFilesReader } from './registry/published-service-files';
import { ServiceDefaultEnvironments } from './publishing/service-default-environments';
import { ServiceRegistry } from './registry/service-registry';
import { TestProjectRefreshes } from './test-lane/test-project-refreshes';
import { ExternalServiceUsageController } from './usage/external-service-usage.controller';
import { IncomingEmailUpgrade } from './upgrade/incoming-email-upgrade';
import { ExternalServiceUsageService } from './usage/external-service-usage.service';
import { RetiredSkillSwapUpgrade } from './upgrade/retired-skill-swap-upgrade';
import { WhatsappUpgrade } from './upgrade/whatsapp-upgrade';
import { DispatchContexts } from './gate/dispatch-contexts';
import { PlatformApiGrant } from './gate/platform-api-grant';
import { PROJECT_LIFECYCLE } from '../project/project-lifecycle';
import { ExternalServicesProjectLifecycle } from './external-services-project-lifecycle';
import { AvailableServiceSwitches } from './knowledge/available-service-switches';

@Global()
@Module({
  imports: [GatewayModule, ProjectEnvironmentModule, SealingModule],
  controllers: [
    WebhooksController,
    ExternalServiceGateController,
    ExternalServiceUsageController,
    PlatformServicesController,
    TenantServicesController,
    ProjectServicesController,
  ],
  providers: [
    ExternalServiceStore,
    ExternalServiceUsageService,
    { provide: BUILT_IN_SERVICES_DIR, useFactory: shippedBuiltInServicesDir },
    PublishedServiceFilesReader,
    CustomServiceCatalog,
    ServiceRegistry,
    GeneratedValueSource,
    GeneratedValueBackfill,
    ServiceDefaultEnvironments,
    ServiceStateFiles,
    {
      provide: SERVICE_POD_PORT,
      useFactory: (config: ConfigService) => config.getOrThrow<number>('appPort'),
      inject: [ConfigService],
    },
    { provide: SERVICE_START_HOLD_MS, useValue: SERVICE_START_HOLD },
    { provide: SERVICE_SWITCH_DRAIN_MS, useValue: SERVICE_SWITCH_DRAIN },
    DefaultLaneHolds,
    ServiceConfigurationStore,
    ServiceAvailability,
    ServiceViews,
    ServiceSkills,
    { provide: ServiceSkillSource, useExisting: ServiceSkills },
    { provide: ServiceSkillAvailability, useExisting: ServiceSkills },
    AvailableServiceSwitches,
    { provide: ServiceSwitchCatalog, useExisting: AvailableServiceSwitches },
    ServiceSkillVersions,
    ServiceSkillReach,
    ConfigurationsAtCreate,
    // TODO: remove in the release after External Services v2 ships: the three one-time upgrades below
    IncomingEmailUpgrade,
    WhatsappUpgrade,
    RetiredSkillSwapUpgrade,
    CustomServiceRepository,
    ProjectConfigurationStore,
    OperationSwitches,
    ProjectConfigurationSaveHooks,
    ServiceConfigurationSaveHooks,
    PendingHooks,
    HookCalls,
    DispatchContexts,
    ProjectConfigurationCarry,
    ConfigurationSaves,
    ServiceConsumers,
    ConfigurationDelivery,
    ProjectServiceViews,
    GateCallers,
    ServicePods,
    ServiceDispatcher,
    CallLog,
    CallLogReader,
    PlatformApiGrant,
    ExternalServiceGate,
    FormCalls,
    GateSurfaces,
    EventReceivers,
    InboundPipeline,
    Doorbell,
    TestProjectRefreshes,
    ExternalServicesProjectLifecycle,
    { provide: PROJECT_LIFECYCLE, useExisting: ExternalServicesProjectLifecycle },
  ],
  exports: [
    ServiceDefaultEnvironments,
    ServiceSkillSource,
    ServiceSkillAvailability,
    ServiceSwitchCatalog,
    ServiceSkillReach,
    PROJECT_LIFECYCLE,
    OperationSwitches,
    Doorbell,
    ServiceRegistry,
    ExternalServiceStore,
    CallLog,
    ProjectConfigurationCarry,
    ConfigurationSaves,
    ServiceConfigurationStore,
    ServiceConfigurationSaveHooks,
    ProjectConfigurationStore,
    ProjectConfigurationSaveHooks,
    GateCallers,
    ExternalServiceGate,
    FormCalls,
    GateSurfaces,
    ServiceConsumers,
    CustomServiceRepository,
  ],
})
export class ExternalServicesModule {}

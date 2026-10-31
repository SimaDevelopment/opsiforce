import { Global, Module } from '@nestjs/common';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import { ServiceSkillAvailability } from '../../src/store/service-skill-availability';
import {
  ServiceSettingsCatalog,
  type ServiceConfigurationOptions,
  type ProjectlessOptionsAnswer,
  type SettableService,
} from '../../src/store/service-settings-catalog';

class EveryServiceAvailable extends ServiceSkillAvailability {
  async availableServiceIds(): Promise<ReadonlySet<string>> {
    const rows = await db.select({ id: externalServices.id }).from(externalServices);
    return new Set(rows.map((row) => row.id));
  }
}

class NoSettableServices extends ServiceSettingsCatalog {
  availableServices(): Promise<SettableService[]> {
    return Promise.resolve([]);
  }

  availableService(): Promise<SettableService | null> {
    return Promise.resolve(null);
  }

  tenantService(): Promise<SettableService | null> {
    return Promise.resolve(null);
  }

  serviceConfigurationOptions(): Promise<ServiceConfigurationOptions[]> {
    return Promise.resolve([]);
  }

  callProjectlessOptions(): Promise<ProjectlessOptionsAnswer> {
    return Promise.reject(new Error('No External Service is available'));
  }
}

@Global()
@Module({
  providers: [
    { provide: ServiceSkillAvailability, useClass: EveryServiceAvailable },
    { provide: ServiceSettingsCatalog, useClass: NoSettableServices },
  ],
  exports: [ServiceSkillAvailability, ServiceSettingsCatalog],
})
export class EveryServiceAvailableModule {}

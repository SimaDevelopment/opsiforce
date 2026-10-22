import { Global, Module } from '@nestjs/common';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import { ServiceSkillAvailability } from '../../src/store/service-skill-availability';
import { ServiceSwitchCatalog, type SwitchableService } from '../../src/store/service-switch-catalog';

class EveryServiceAvailable extends ServiceSkillAvailability {
  async availableServiceIds(): Promise<ReadonlySet<string>> {
    const rows = await db.select({ id: externalServices.id }).from(externalServices);
    return new Set(rows.map((row) => row.id));
  }
}

class NoServiceSwitches extends ServiceSwitchCatalog {
  availableService(): Promise<SwitchableService | null> {
    return Promise.resolve(null);
  }
}

@Global()
@Module({
  providers: [
    { provide: ServiceSkillAvailability, useClass: EveryServiceAvailable },
    { provide: ServiceSwitchCatalog, useClass: NoServiceSwitches },
  ],
  exports: [ServiceSkillAvailability, ServiceSwitchCatalog],
})
export class EveryServiceAvailableModule {}

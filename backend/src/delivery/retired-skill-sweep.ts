import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SkillDeliveryService } from './skill-delivery.service';

@Injectable()
export class RetiredSkillSweep implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetiredSkillSweep.name);

  constructor(private readonly skillDeliveries: SkillDeliveryService) {}

  async onApplicationBootstrap(): Promise<void> {
    const holding = await this.skillDeliveries.enqueueEnvironmentsHoldingRetiredSkills();
    if (holding.length > 0) this.logger.log(`Removing retired skills from ${holding.length} environment(s)`);
  }
}

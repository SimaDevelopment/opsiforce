import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATFORM_OWNER } from '../configuration/configuration-values';
import { InvalidConfigurationError } from '../configuration/invalid-configuration.error';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { ServiceSkillReach } from '../knowledge/service-skill-reach';
import { ServiceRegistry } from '../registry/service-registry';

const INCOMING_EMAIL_SERVICE = 'incoming-email';

// TODO: remove in the release after External Services v2 ships: one-time v1 import, a no-op once every deployment has booted it
@Injectable()
export class IncomingEmailUpgrade implements OnApplicationBootstrap {
  private readonly logger = new Logger(IncomingEmailUpgrade.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly config: ConfigService,
    private readonly serviceSkillReach: ServiceSkillReach
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const service = this.registry.bySlug(INCOMING_EMAIL_SERVICE);
    const receivingDomain = this.config.get<string>('mailgunReceiveDomain', '').trim();
    const signingKey = this.config.get<string>('mailgunWebhookSigningKey', '').trim();
    if (!service || !receivingDomain || !signingKey) return;

    try {
      const wrote = await this.serviceConfigurations.startWith(service, PLATFORM_OWNER, {
        receivingDomain,
        signingKey,
      });
      if (wrote) {
        this.logger.log(`Imported the ${INCOMING_EMAIL_SERVICE} Service configuration from the Mailgun settings`);
        await this.serviceSkillReach.layAndReach(service);
      }
    } catch (error) {
      if (!(error instanceof InvalidConfigurationError)) throw error;
      this.logger.error(
        `The Mailgun settings do not fit the ${INCOMING_EMAIL_SERVICE} Service form (${error.message}); configure it on its service page`
      );
    }
  }
}

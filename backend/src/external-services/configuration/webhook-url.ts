import type { ConfigService } from '@nestjs/config';
import type { ServiceLane } from '../registry/custom-service-catalog';
import type { RegisteredService } from '../registry/service-registry';

export const WEBHOOKS_MOUNT = 'external-services/webhooks';

export const SERVICE_WEBHOOKS_PATH = `/api/${WEBHOOKS_MOUNT}`;

export const DEVELOPMENT_WEBHOOK_SUFFIX = 'development';

export function publicUrlFrom(configured: string): string {
  const publicUrl = configured.trim().replace(/\/+$/, '');
  if (!URL.canParse(publicUrl) || !['http:', 'https:'].includes(new URL(publicUrl).protocol)) {
    throw new Error(
      `OPSIFORCE_PUBLIC_URL must be the deployment's absolute public origin, such as https://opsiforce.example.com; got "${configured}"`
    );
  }
  return publicUrl;
}

export function configuredPublicUrl(config: ConfigService): string {
  return publicUrlFrom(config.get<string>('opsiforcePublicUrl', ''));
}

type WebhookTarget = Pick<RegisteredService, 'id' | 'slug' | 'origin'> & { home: { lane: ServiceLane } | null };

export function serviceWebhookUrl(config: ConfigService, service: WebhookTarget): string {
  return webhookUrlOf(configuredPublicUrl(config), service);
}

export function webhookUrlOf(publicUrl: string, service: WebhookTarget): string {
  if (service.origin !== 'custom') return `${publicUrl}${SERVICE_WEBHOOKS_PATH}/${service.slug}`;
  const lane = service.home?.lane === 'development' ? `/${DEVELOPMENT_WEBHOOK_SUFFIX}` : '';
  return `${publicUrl}${SERVICE_WEBHOOKS_PATH}/${service.id}${lane}`;
}

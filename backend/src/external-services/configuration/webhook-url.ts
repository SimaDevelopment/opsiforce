import type { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices } from '../../../db/schema';
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
  return customServiceWebhookUrl(publicUrl, service.id, service.home?.lane ?? 'default');
}

function customServiceWebhookUrl(publicUrl: string, serviceId: string, lane: ServiceLane): string {
  const suffix = lane === 'development' ? `/${DEVELOPMENT_WEBHOOK_SUFFIX}` : '';
  return `${publicUrl}${SERVICE_WEBHOOKS_PATH}/${serviceId}${suffix}`;
}

export async function podWebhookUrl(
  config: ConfigService,
  environment: { projectId: string; isDefault: boolean }
): Promise<string | undefined> {
  const publicUrl = config.get<string>('opsiforcePublicUrl', '');
  if (publicUrl.trim() === '') return undefined;
  const [service] = await db
    .select({ id: externalServices.id })
    .from(externalServices)
    .where(eq(externalServices.builderChatId, environment.projectId));
  if (!service) return undefined;
  return customServiceWebhookUrl(
    publicUrlFrom(publicUrl),
    service.id,
    environment.isDefault ? 'development' : 'default'
  );
}

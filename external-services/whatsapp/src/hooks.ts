import { ServiceError, type HookContext, type Hooks } from '@opsiforce/external-service-sdk';

import type { Manifest, ServiceConfiguration } from '../service.types.ts';
import {
  apiBaseOf,
  asServiceError,
  channelOf,
  registeredSecretOf,
  registeredWebhooks,
  webhookSecretHeader,
  whapi,
  type Channel,
} from './client.ts';

async function registerWebhook(
  configuration: ServiceConfiguration,
  channel: Channel,
  webhookUrl: string,
  signal: AbortSignal
): Promise<void> {
  const webhookSecret = channel.webhookSecret?.reveal();
  if (!webhookSecret) return;
  const others = (await registeredWebhooks(configuration, channel, signal)).filter(
    (webhook) => registeredSecretOf(webhook) === undefined && webhook.url !== webhookUrl
  );
  await whapi(configuration, channel, {
    method: 'PATCH',
    path: '/settings',
    signal,
    body: {
      webhooks: [
        ...others,
        {
          url: webhookUrl,
          mode: 'body',
          headers: { [webhookSecretHeader]: webhookSecret },
          events: [{ type: 'messages', method: 'post' }],
        },
      ],
    },
  });
}

async function removeWebhook(
  configuration: ServiceConfiguration,
  channel: Channel,
  webhookUrl: string,
  signal: AbortSignal
): Promise<void> {
  const secret = channel.webhookSecret?.reveal();
  const webhooks = await registeredWebhooks(configuration, channel, signal);
  const others = webhooks.filter(
    (webhook) => webhook.url !== webhookUrl && (secret === undefined || registeredSecretOf(webhook) !== secret)
  );
  if (others.length === webhooks.length) return;
  await whapi(configuration, channel, { method: 'PATCH', path: '/settings', signal, body: { webhooks: others } });
}

function needsRegistration(channel: Channel, before: Channel | undefined, apiUrlChanged: boolean): boolean {
  if (!before || apiUrlChanged) return true;
  return (
    before.channelId !== channel.channelId ||
    before.apiToken.reveal() !== channel.apiToken.reveal() ||
    before.webhookSecret?.reveal() !== channel.webhookSecret?.reveal()
  );
}

async function removeWebhooksOfRemovedNumbers(
  previous: ServiceConfiguration,
  current: ServiceConfiguration | null,
  ctx: HookContext<Manifest>
): Promise<void> {
  for (const channel of (previous.channels ?? []).filter((removed) => !current || !channelOf(current, removed.id))) {
    try {
      await removeWebhook(previous, channel, ctx.webhookUrl, ctx.signal);
      ctx.log.info('Removed the WhatsApp webhook from Whapi', { channelId: channel.channelId });
    } catch (error) {
      ctx.log.warn('Could not remove the WhatsApp webhook of a removed number', {
        number: channel.label,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const onServiceConfigurationSaved: NonNullable<Hooks<Manifest>['onServiceConfigurationSaved']> = async (
  { previous, current },
  ctx
) => {
  if (previous) await removeWebhooksOfRemovedNumbers(previous, current, ctx);
  if (!current) return;
  const apiUrlChanged = previous !== null && apiBaseOf(previous) !== apiBaseOf(current);
  const changed = (current.channels ?? []).filter((channel) =>
    needsRegistration(channel, previous ? channelOf(previous, channel.id) : undefined, apiUrlChanged)
  );
  if (changed.length === 0) return;
  if (!ctx.webhookUrl) {
    throw new ServiceError({
      status: 409,
      code: 'no-public-url',
      detail: 'OPSIFORCE_PUBLIC_URL is not set, so Whapi cannot be given a webhook URL.',
    });
  }
  let firstFailure: unknown;
  for (const channel of changed) {
    try {
      await registerWebhook(current, channel, ctx.webhookUrl, ctx.signal);
    } catch (error) {
      firstFailure ??= asServiceError(error, channel);
      continue;
    }
    ctx.log.info('Registered the WhatsApp webhook with Whapi', { channelId: channel.channelId });
  }
  if (firstFailure !== undefined) throw firstFailure;
};

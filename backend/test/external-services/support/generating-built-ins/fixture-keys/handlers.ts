import { defineHandlers, ServiceError } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

const recordedHooks = ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.fixture-keys.hooks')] ??=
  new Map<string, unknown>()) as Map<string, unknown>;

function labelsOf(channels: { label: string }[] | undefined): string[] {
  return (channels ?? []).map((channel) => channel.label);
}

export default defineHandlers<Manifest>({
  manifestHash,
  operations: {
    send_message: (input) => ({ sent: input.text, channel: input.channel }),
  },
  hooks: {
    onServiceConfigurationSaved: ({ previous, current }) => {
      if (current?.apiToken?.reveal() === 'refused-upstream') {
        throw new ServiceError({ status: 502, code: 'upstream-refused', detail: 'The provider refused the webhook.' });
      }
      recordedHooks.set('hooks/service', {
        previous: previous ? labelsOf(previous.channels) : null,
        current: current ? labelsOf(current.channels) : null,
        webhookSecrets: (current?.channels ?? []).map((channel) => channel.webhookSecret?.reveal() ?? null),
      });
    },
    onProjectConfigurationSaved: ({ previous, current }, ctx) => {
      recordedHooks.set(`hooks/project/${ctx.caller?.environmentId ?? 'none'}`, {
        previous: previous?.localPart ?? null,
        current: current?.localPart ?? null,
        previousChannel: previous?.channel ?? null,
        currentChannel: current?.channel ?? null,
        receive: current?.receive ?? null,
        channels: labelsOf(ctx.serviceConfiguration.channels),
      });
    },
  },
  inbound: () => ({ events: [] }),
});

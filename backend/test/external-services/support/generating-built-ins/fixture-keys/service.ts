import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineService } from '@opsiforce/external-service-sdk';

import manifest from './service.json';
import type { Manifest } from './service.types.ts';

const recordedHooks = ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.fixture-keys.hooks')] ??=
  new Map<string, unknown>()) as Map<string, unknown>;

function labelsOf(channels: { label: string }[] | undefined): string[] {
  return (channels ?? []).map((channel) => channel.label);
}

export default defineService<Manifest>({
  manifest,
  routes: [],
  hooks: {
    onServiceConfigurationSaved: ({ previous, current }) => {
      if (current?.apiToken?.reveal() === 'refused-upstream') throw new Error('The provider refused the webhook.');
      if (recordedHooks.get('fail/service') === true) throw new Error('Try later.');
      recordedHooks.set('hooks/service', {
        previous: previous ? labelsOf(previous.channels) : null,
        current: current ? labelsOf(current.channels) : null,
        webhookSecrets: (current?.channels ?? []).map((channel) => channel.webhookSecret?.reveal() ?? null),
      });
    },
    onProjectConfigurationSaved: ({ previous, current }, ctx) => {
      if (recordedHooks.get('fail/project') === true) throw new Error('The provider already routes it.');
      const projectEnvironmentId = ctx.caller.projectEnvironmentId ?? 'none';
      const skill = join(process.env.STORAGE_MOUNT_PATH ?? '', 'projects', projectEnvironmentId, '.opencode/skills');
      recordedHooks.set(`hooks/project/${projectEnvironmentId}`, {
        previous: previous?.localPart ?? null,
        current: current?.localPart ?? null,
        previousChannel: previous?.channel ?? null,
        currentChannel: current?.channel ?? null,
        greeting: current?.greeting ?? null,
        channels: labelsOf(ctx.serviceConfiguration.channels),
        skillDelivered: existsSync(join(skill, 'service-fixture-keys', 'SKILL.md')),
      });
    },
  },
});

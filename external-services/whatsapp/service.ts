import { defineService } from '@opsiforce/external-service-sdk';

import manifest from './service.json' with { type: 'json' };
import type { Manifest } from './service.types.ts';
import { listChats, showQr, webhookStatus } from './src/forms.ts';
import { onServiceConfigurationSaved } from './src/hooks.ts';
import { webhook } from './src/webhook.ts';

export default defineService<Manifest>({
  manifest,
  routes: [],
  options: { listChats },
  info: { webhookStatus },
  buttons: { showQr },
  hooks: { onServiceConfigurationSaved },
  webhook,
});

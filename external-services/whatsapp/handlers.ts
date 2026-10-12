import { defineHandlers } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';
import { listChats, showQr, webhookStatus } from './src/forms.ts';
import { onServiceConfigurationSaved } from './src/hooks.ts';
import { inbound } from './src/inbound.ts';

export default defineHandlers<Manifest>({
  manifestHash,
  options: { listChats },
  info: { webhookStatus },
  buttons: { showQr },
  hooks: { onServiceConfigurationSaved },
  inbound,
});

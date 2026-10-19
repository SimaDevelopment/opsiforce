import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineService } from '@opsiforce/external-service-sdk';

import manifest from './service.json';
import type { Manifest } from './service.types.ts';

interface ProviderEvent {
  type: Manifest['events'];
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

function signedBy(body: string, key: string, signature: string | null): boolean {
  const expected = createHmac('sha256', key).update(body).digest();
  const presented = Buffer.from(signature ?? '', 'hex');
  return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

export default defineService<Manifest>({
  manifest,
  routes: [],
  webhook: async (request, ctx) => {
    const body = await request.text();
    if (!signedBy(body, ctx.serviceConfiguration.signingKey.reveal(), request.headers.get('x-fixture-signature'))) {
      return Response.json({ message: 'The signature does not match.' }, { status: 401 });
    }
    const { events = [] } = JSON.parse(body) as { events?: ProviderEvent[] };
    const receivers = await ctx.service.projectConfigurations();
    for (const event of events) {
      const to = receivers
        .filter((receiver) => receiver.projectConfiguration.address === event.data.address)
        .map((receiver) => receiver.projectEnvironmentId);
      if (to.length > 0) await ctx.service.deliver(event, { to });
    }
    return undefined;
  },
});

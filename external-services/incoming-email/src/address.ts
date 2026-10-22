import type { RouteHandler } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

export const address: RouteHandler<Manifest> = (_request, ctx) => {
  const { localPart } = ctx.projectConfiguration;
  if (!localPart) return ctx.notAllowed({ setting: 'localPart', message: 'This environment has no address yet' });
  return Response.json({ address: `${localPart}@${ctx.serviceConfiguration.receivingDomain}` });
};

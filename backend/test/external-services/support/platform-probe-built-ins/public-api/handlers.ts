import { defineHandlers, type PlatformApiAccess } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

let keptAccess: PlatformApiAccess | undefined;

async function statusOf(access: PlatformApiAccess | undefined, path: string): Promise<number | null> {
  if (!access) return null;
  const response = await fetch(`${access.url}${path}`, {
    headers: { authorization: `Bearer ${access.token.reveal()}` },
  });
  return response.status;
}

export default defineHandlers<Manifest>({
  manifestHash,
  operations: {
    get_me: async ({ probe }, ctx) => {
      switch (probe) {
        case 'me-twice':
          return {
            first: await statusOf(ctx.platformApi, '/api/v1/me'),
            second: await statusOf(ctx.platformApi, '/api/v1/me'),
          };
        case 'keep':
          keptAccess = ctx.platformApi;
          return { kept: keptAccess !== undefined };
        case 'me-with-kept':
          return { status: await statusOf(keptAccess, '/api/v1/me') };
        case 'another-route':
          return { status: await statusOf(ctx.platformApi, '/api/v1/projects') };
      }
    },
  },
});

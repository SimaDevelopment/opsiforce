import { z } from 'zod';
import { OrganizationRefSchema } from '../errors/error.schema';

export const MeSchema = z
  .strictObject({
    id: z.string(),
    username: z.string(),
    email: z.string().nullable(),
    displayName: z.string(),
    source: z
      .enum(['idp-bearer', 'gateway-key'])
      .describe('How this call authenticated: an IdP bearer token, or the gateway key of a pod acting for this user'),
    organization: OrganizationRefSchema,
    organizations: z.array(OrganizationRefSchema),
    permissions: z.array(z.string()),
  })
  .meta({ id: 'Me' });

export type MeDto = z.infer<typeof MeSchema>;

import { z } from 'zod';
import { TenantRefSchema } from '../errors/error.schema';

export const MeSchema = z
  .strictObject({
    id: z.string(),
    username: z.string(),
    email: z.string().nullable(),
    displayName: z.string(),
    source: z
      .enum(['idp-bearer', 'gateway-key'])
      .describe('How this call authenticated: an IdP bearer token, or the gateway key of a pod acting for this user'),
    tenant: TenantRefSchema,
    tenants: z.array(TenantRefSchema),
    permissions: z.array(z.string()),
    builderSubject: z
      .strictObject({
        type: z.enum(['agent', 'skill']),
        id: z.string(),
        name: z.string().describe("The slug: the Agent's, or the `name` every Version of the Skill must carry"),
        displayName: z.string().nullable(),
        disabled: z.boolean(),
      })
      .nullable()
      .describe(
        'For the gateway key of a Skill & Agent Builder chat: the one Skill or Agent that chat authors. Null for every other caller.'
      ),
    builderTestProject: z
      .strictObject({ id: z.string() })
      .nullable()
      .describe(
        'For the gateway key of a Skill & Agent Builder chat that has created its Test Project: that Project. Null for every other caller, and for a chat that has none yet.'
      ),
  })
  .meta({ id: 'Me' });

export type MeDto = z.infer<typeof MeSchema>;

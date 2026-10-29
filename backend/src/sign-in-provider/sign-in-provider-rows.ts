import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { signInProviders } from '../../db/schema';
import type { SecretSealer } from '../sealing/secret-sealer';
import type { SignInProviderConnection } from './sign-in-provider.types';

export type SignInProviderRow = typeof signInProviders.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clientSecretPlace = (providerId: string) => `sign-in-provider:${providerId}:client-secret`;

export function sealClientSecret(sealer: SecretSealer, providerId: string, clientSecret: string): string {
  return JSON.stringify(sealer.seal(clientSecret, clientSecretPlace(providerId)));
}

export function connectionOf(sealer: SecretSealer, row: SignInProviderRow): SignInProviderConnection {
  const clientSecret = sealer.open(JSON.parse(row.clientSecret), clientSecretPlace(row.id));
  if (typeof clientSecret !== 'string')
    throw new Error(`The client secret of sign-in provider ${row.id} is not a string`);
  return {
    id: row.id,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    clientSecret,
    scope: row.scope,
    requiredClaim: row.requiredClaimName ? { name: row.requiredClaimName, values: row.requiredClaimValues } : undefined,
    groupsClaim: row.groupsClaim ?? undefined,
  };
}

export async function findTenantSignInProvider(tenantId: string, providerId: string): Promise<SignInProviderRow> {
  if (!UUID_PATTERN.test(providerId)) throw new NotFoundException(`Sign-in provider ${providerId} not found`);
  const [row] = await db
    .select()
    .from(signInProviders)
    .where(and(eq(signInProviders.id, providerId), eq(signInProviders.tenantId, tenantId)));
  if (!row) throw new NotFoundException(`Sign-in provider ${providerId} not found`);
  return row;
}

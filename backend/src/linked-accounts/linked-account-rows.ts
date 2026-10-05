import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { linkedAccounts, modelProviders } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import type { VendorId } from './vendor-adapter';
import { isVendorId } from './vendors';

export const CALLER_SECRET_PREFIX = 'lap_';
const CALLER_SECRET_BYTES = 32;

export function newCallerSecret(): string {
  return `${CALLER_SECRET_PREFIX}${randomBytes(CALLER_SECRET_BYTES).toString('base64url')}`;
}

export function callerSecretHashOf(callerSecret: string): string {
  return createHash('sha256').update(callerSecret).digest('hex');
}

export async function insertAwaitingSignIn(
  executor: DbExecutor,
  modelProviderId: string,
  vendor: VendorId,
  callerSecret: string
): Promise<void> {
  await executor
    .insert(linkedAccounts)
    .values({ modelProviderId, vendor, callerSecretHash: callerSecretHashOf(callerSecret) });
}

export async function platformLinkedAccountVendors(
  executor: DbExecutor,
  bifrostProvider?: string
): Promise<Map<string, VendorId>> {
  const rows = await executor
    .select({ bifrostProvider: modelProviders.bifrostProvider, vendor: linkedAccounts.vendor })
    .from(linkedAccounts)
    .innerJoin(modelProviders, eq(modelProviders.id, linkedAccounts.modelProviderId))
    .where(
      and(
        isNull(modelProviders.tenantId),
        ...(bifrostProvider === undefined ? [] : [eq(modelProviders.bifrostProvider, bifrostProvider)])
      )
    );
  return new Map(rows.flatMap((row) => (isVendorId(row.vendor) ? [[row.bifrostProvider, row.vendor] as const] : [])));
}

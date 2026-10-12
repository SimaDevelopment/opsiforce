import type { INestApplication } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceConfigs, externalServices, type JsonValue } from '../../../db/schema';
import { Perms } from '../../../src/permission/permission.constants';
import { addMember, createTenant, type MemberFixture, type TenantFixture } from '../../support/project-fixtures';

export interface PersonFixture extends MemberFixture {
  tenant: TenantFixture;
}

async function personWith(app: INestApplication, permissions: string[]): Promise<PersonFixture> {
  const tenant = await createTenant(app);
  const member = await addMember(app, tenant, permissions);
  return { ...member, tenant };
}

export function platformOperator(app: INestApplication): Promise<PersonFixture> {
  return personWith(app, [Perms.managePlatformExternalServices]);
}

export function tenantAdmin(app: INestApplication): Promise<PersonFixture> {
  return personWith(app, [Perms.manageTenantExternalServices]);
}

export function memberWithout(app: INestApplication): Promise<PersonFixture> {
  return personWith(app, [Perms.usePublicApi]);
}

export async function builtInServiceId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: externalServices.id })
    .from(externalServices)
    .where(and(eq(externalServices.slug, slug), isNull(externalServices.tenantId)));
  if (!row) throw new Error(`No built-in External Service ${slug}`);
  return row.id;
}

export async function forgetPlatformServiceConfiguration(slug: string): Promise<void> {
  await db
    .delete(externalServiceConfigs)
    .where(eq(externalServiceConfigs.externalServiceId, await builtInServiceId(slug)));
}

export async function storedPlatformServiceConfiguration(slug: string): Promise<Record<string, JsonValue> | null> {
  const [row] = await db
    .select({ values: externalServiceConfigs.values })
    .from(externalServiceConfigs)
    .where(
      and(
        eq(externalServiceConfigs.externalServiceId, await builtInServiceId(slug)),
        isNull(externalServiceConfigs.tenantId),
        isNull(externalServiceConfigs.environment)
      )
    );
  return row?.values ?? null;
}

export async function storePlatformServiceConfiguration(
  slug: string,
  values: Record<string, JsonValue>
): Promise<void> {
  await db
    .insert(externalServiceConfigs)
    .values({ id: crypto.randomUUID(), externalServiceId: await builtInServiceId(slug), values })
    .onConflictDoUpdate({
      target: [
        externalServiceConfigs.externalServiceId,
        externalServiceConfigs.tenantId,
        externalServiceConfigs.environment,
      ],
      set: { values },
    });
}

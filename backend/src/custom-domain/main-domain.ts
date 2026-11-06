import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { customDomains, projectEnvironments, type CustomDomainStatusValue } from '../../db/schema';

export const ROUTED_DOMAIN_STATUSES: CustomDomainStatusValue[] = ['issuing', 'connected'];

const isConnectedMainDomain = and(eq(customDomains.isMain, true), eq(customDomains.status, 'connected'));

export const connectedMainDomain = sql<string | null>`(${db
  .select({ hostname: customDomains.hostname })
  .from(customDomains)
  .where(and(eq(customDomains.projectEnvironmentId, projectEnvironments.id), isConnectedMainDomain))})`;

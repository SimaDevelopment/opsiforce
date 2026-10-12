import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceCalls, externalServiceUsage } from '../../../db/schema';

export type StagedCall = typeof externalServiceCalls.$inferInsert;

export type UsageRow = typeof externalServiceUsage.$inferSelect;

export function usageRowsOf(projectEnvironmentId: string): Promise<UsageRow[]> {
  return db
    .select()
    .from(externalServiceUsage)
    .where(eq(externalServiceUsage.projectEnvironmentId, projectEnvironmentId));
}

export function thisMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export async function stageCalls(
  rows: (Partial<Omit<StagedCall, 'createdAt'>> & { createdAt?: Date | string })[]
): Promise<string[]> {
  const staged = rows.map(({ createdAt, ...row }) => ({
    id: crypto.randomUUID(),
    kind: 'operation',
    slug: 'fixture-crm',
    decision: 'allowed',
    status: 200,
    durationMs: 3,
    ...row,
    ...(createdAt === undefined
      ? {}
      : { createdAt: typeof createdAt === 'string' ? sql`${createdAt}::timestamp` : createdAt }),
  }));
  if (staged.length > 0) await db.insert(externalServiceCalls).values(staged as StagedCall[]);
  return staged.map((row) => row.id);
}

export function microsecondTimestamps(count: number, perMillisecond = 3): string[] {
  const base = Date.now() - 60 * 60 * 1000;
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(base + Math.floor(index / perMillisecond)).toISOString();
    return `${at.slice(0, 10)} ${at.slice(11, 23)}${String(index % perMillisecond).padStart(3, '0')}`;
  });
}

export async function backdateCall(id: string, createdAt: Date): Promise<void> {
  await db.update(externalServiceCalls).set({ createdAt }).where(eq(externalServiceCalls.id, id));
}

export async function callIdsOf(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: externalServiceCalls.id })
    .from(externalServiceCalls)
    .where(sql`${externalServiceCalls.id} in ${ids}`);
  return rows.map((row) => row.id);
}

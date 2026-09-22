import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db';
import { projectAgentUpdates } from '../../db/schema';
import { AgentUpdateStatus } from './agent-update.types';

/** How long a `running` row is believed before it is treated as a killed process's leftover. */
export const AGENT_UPDATE_STALE_AFTER_MS = 15 * 60 * 1000;

/** Answers whether the Kubernetes Job behind a `running` row is still writing. */
export type SurvivingJobProbe = (updateId: string) => Promise<boolean>;

export async function reapStaleRunningAgentUpdates(isJobRunning?: SurvivingJobProbe): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AGENT_UPDATE_STALE_AFTER_MS);
  const stale = await db
    .select({ id: projectAgentUpdates.id })
    .from(projectAgentUpdates)
    .where(and(eq(projectAgentUpdates.status, AgentUpdateStatus.Running), lt(projectAgentUpdates.startedAt, cutoff)));
  if (stale.length === 0) return;

  for (const row of stale) {
    if (isJobRunning && (await isJobRunning(row.id).catch(() => false))) {
      await db
        .update(projectAgentUpdates)
        .set({ startedAt: now, updatedAt: now })
        .where(eq(projectAgentUpdates.id, row.id));
      continue;
    }
    await db
      .update(projectAgentUpdates)
      .set({ status: AgentUpdateStatus.Failed, error: 'process_terminated', finishedAt: now, updatedAt: now })
      .where(eq(projectAgentUpdates.id, row.id));
  }
}

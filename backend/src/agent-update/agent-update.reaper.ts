import { and, eq, lt } from 'drizzle-orm';
import type { ConfigService } from '@nestjs/config';
import { db } from '../../db';
import { projectAgentUpdates } from '../../db/schema';
import { AgentUpdateStatus } from './agent-update.types';

const DEFAULT_AGENT_UPDATE_JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const AGENT_UPDATE_JOB_COMPLETION_GRACE_MS = 60_000;

/**
 * A `running` row older than the Job's `activeDeadlineSeconds` plus the completion grace has no live
 * Job behind it, because Kubernetes has already killed one that old; anything younger may still be writing.
 */
export function agentUpdateStaleAfterMs(configService: ConfigService): number {
  return (
    configService.get<number>('agentUpdateJobTimeoutMs', DEFAULT_AGENT_UPDATE_JOB_TIMEOUT_MS) +
    AGENT_UPDATE_JOB_COMPLETION_GRACE_MS
  );
}

/** Answers whether the Kubernetes Job behind a `running` row is still writing. */
export type SurvivingJobProbe = (updateId: string) => Promise<boolean>;

export async function reapStaleRunningAgentUpdates(
  staleAfterMs: number,
  isJobRunning?: SurvivingJobProbe
): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - staleAfterMs);
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

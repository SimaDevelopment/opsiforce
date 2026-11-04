import { ConflictException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { agents, projects } from '../../db/schema';
import type { DbExecutor } from '../common/locks';

export class CreatedAgentsCapReached extends ConflictException {
  constructor(readonly max: number) {
    super({
      code: 'created_agents_cap_reached',
      message: `The creating Project may create at most ${max} Agents.`,
    });
  }
}

export interface CreatedAgentsCap {
  creatingProjectId: string;
  max: number;
}

export async function assertRoomForCreatedAgent(
  executor: DbExecutor,
  cap: CreatedAgentsCap | null | undefined
): Promise<void> {
  if (!cap) return;
  await executor.select({ id: projects.id }).from(projects).where(eq(projects.id, cap.creatingProjectId)).for('update');
  const [row] = await executor
    .select({ created: count() })
    .from(agents)
    .where(eq(agents.createdByProjectId, cap.creatingProjectId));
  if ((row?.created ?? 0) >= cap.max) throw new CreatedAgentsCapReached(cap.max);
}

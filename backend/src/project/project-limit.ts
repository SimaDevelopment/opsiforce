import { ConflictException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { projects } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import { assertWithinLimit } from '../limit/limits';
import type { ProjectKind } from './project.types';

export async function assertRoomForProject(
  executor: DbExecutor,
  tenantId: string,
  kind: ProjectKind | null = null
): Promise<void> {
  if (kind !== null) return;
  await assertWithinLimit(executor, tenantId, 'projects');
}

export class CreatedProjectsCapReached extends ConflictException {
  constructor(readonly max: number) {
    super({
      code: 'created_projects_cap_reached',
      message: `The creating Project may create at most ${max} Projects.`,
    });
  }
}

export interface CreatedProjectsCap {
  creatingProjectId: string;
  max: number;
}

export async function assertRoomForCreatedProject(
  executor: DbExecutor,
  cap: CreatedProjectsCap | null | undefined
): Promise<void> {
  if (!cap) return;
  await executor.select({ id: projects.id }).from(projects).where(eq(projects.id, cap.creatingProjectId)).for('update');
  const [row] = await executor
    .select({ created: count() })
    .from(projects)
    .where(eq(projects.createdByProjectId, cap.creatingProjectId));
  if ((row?.created ?? 0) >= cap.max) throw new CreatedProjectsCapReached(cap.max);
}

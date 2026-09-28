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

import { sql, type SQL } from 'drizzle-orm';
import { projects } from '../../../db/schema';
import { TEST_PROJECT_KIND } from '../../project/project.types';
import type { RegisteredService } from '../registry/service-registry';

function isTestProjectOf(builderChatId: string): SQL {
  return sql`((${projects.kind} = ${TEST_PROJECT_KIND} and ${projects.createdByProjectId} = ${builderChatId}) is true)`;
}

export function laneReceivers(service: RegisteredService): SQL[] {
  if (!service.home) return [];
  const testProject = isTestProjectOf(service.home.builderChatId);
  return [service.home.lane === 'development' ? testProject : sql`not ${testProject}`];
}

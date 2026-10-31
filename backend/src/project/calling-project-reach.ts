import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { projects } from '../../db/schema';
import type { PublicApiSettingValues } from '../external-services/configuration/public-api-settings';

export interface CallingProjectReach {
  projectId: string;
  otherProjectIds: readonly string[];
}

export function callingProjectReachOf(projectId: string, settings: PublicApiSettingValues | null): CallingProjectReach {
  return { projectId, otherProjectIds: settings?.otherProjects ?? [] };
}

export function otherProjectCandidatesWhere(callingProjectId: string): SQL | undefined {
  return and(
    ne(projects.id, callingProjectId),
    isNull(projects.kind),
    or(isNull(projects.createdByProjectId), ne(projects.createdByProjectId, callingProjectId))
  );
}

export function reachedByCallingProjectWhere(reach: CallingProjectReach): SQL | undefined {
  return or(
    eq(projects.createdByProjectId, reach.projectId),
    reach.otherProjectIds.length === 0
      ? undefined
      : and(inArray(projects.id, [...reach.otherProjectIds]), otherProjectCandidatesWhere(reach.projectId))
  );
}

export async function isReachedByCallingProject(projectId: string, reach: CallingProjectReach): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), reachedByCallingProjectWhere(reach)))
    .limit(1);
  return row !== undefined;
}

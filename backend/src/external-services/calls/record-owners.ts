import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { environments, projectEnvironments, projects } from '../../../db/schema';

export interface KnownEnvironment {
  projectId: string;
  environmentName: string;
  isDefault: boolean;
}

export async function knownEnvironments(
  tenantId: string,
  ids: readonly string[]
): Promise<Map<string, KnownEnvironment>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: projectEnvironments.id,
      projectId: projectEnvironments.projectId,
      name: environments.name,
      isDefault: projectEnvironments.isDefault,
    })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
    .where(and(inArray(projectEnvironments.id, [...ids]), eq(projects.tenantId, tenantId)));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        projectId: row.projectId,
        environmentName: row.name ?? (row.isDefault ? 'Development' : 'Environment'),
        isDefault: row.isDefault,
      },
    ])
  );
}

export async function projectTitles(tenantId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(inArray(projects.id, [...ids]), eq(projects.tenantId, tenantId)));
  return new Map(rows.map((row) => [row.id, row.title]));
}

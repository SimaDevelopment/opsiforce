import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projects } from '../../db/schema';
import type { ProjectKind } from './project.types';

@Injectable()
export class ProjectProvenanceRepository {
  async findCreatorId(projectId: string): Promise<string | null> {
    const [row] = await db.select({ createdBy: projects.createdBy }).from(projects).where(eq(projects.id, projectId));
    return row?.createdBy ?? null;
  }

  async findKind(projectId: string): Promise<ProjectKind | null> {
    const [row] = await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId));
    return row?.kind ?? null;
  }

  async isCreatedByProject(projectId: string, creatingProjectId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.createdByProjectId, creatingProjectId)));
    return row !== undefined;
  }
}

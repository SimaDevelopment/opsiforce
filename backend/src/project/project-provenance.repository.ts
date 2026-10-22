import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projects } from '../../db/schema';
import { MAX_PROJECT_CHAIN_DEPTH } from './project.constants';
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

  async chainDepth(projectId: string): Promise<number> {
    let depth = 0;
    let parentId = await this.parentOf(projectId);
    while (parentId !== null && depth < MAX_PROJECT_CHAIN_DEPTH) {
      depth += 1;
      parentId = await this.parentOf(parentId);
    }
    return depth;
  }

  private async parentOf(projectId: string): Promise<string | null> {
    const [row] = await db
      .select({ parentId: projects.createdByProjectId })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.parentId ?? null;
  }
}

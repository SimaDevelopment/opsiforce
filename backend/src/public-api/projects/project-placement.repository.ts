import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, folders, workspaces } from '../../../db/schema';

@Injectable()
export class ProjectPlacementRepository {
  async agentExists(agentId: string): Promise<boolean> {
    const [row] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
    return row !== undefined;
  }

  async findFolderWorkspaceId(folderId: string): Promise<string | null> {
    const [row] = await db
      .select({ workspaceId: folders.workspaceId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);
    return row?.workspaceId ?? null;
  }

  async findPersonalWorkspaceId(tenantId: string, userId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.ownerId, userId), eq(workspaces.type, 'private')))
      .limit(1);
    return row?.id ?? null;
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import {
  FOLDERS_WORKSPACE_NAME_CI_UNIQUE,
  folders,
  projects,
  users,
  userWorkspacePreferences,
  workspaceMembers,
  workspaces,
} from '../../db/schema';
import { Perms } from '../permission/permission.constants';
import { ProjectService } from '../project/project.service';
import { TenantService } from '../tenant/tenant.service';
import type { CreateProjectDto, ProjectResponse } from '../project/project.types';
import type { UserRecord } from '../user/user.service';
import type {
  CreateFolderDto,
  CreateWorkspaceDto,
  FolderResponse,
  RenameFolderDto,
  UpdateWorkspaceDto,
  WorkspaceAccessParams,
  WorkspaceResponse,
} from './workspace.types';

const workspaceBaseFields = {
  id: workspaces.id,
  tenantId: workspaces.tenantId,
  type: workspaces.type,
  ownerId: workspaces.ownerId,
  name: workspaces.name,
  description: workspaces.description,
  createdAt: workspaces.createdAt,
  updatedAt: workspaces.updatedAt,
};

type WorkspaceBaseRow = typeof workspaces.$inferSelect;

const PRIVATE_WORKSPACE_NAME = 'Personal';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly tenantService: TenantService
  ) {}

  /**
   * Returns workspaces the user is a member of (sidebar view). No admin
   * bypass — admins only see workspaces they joined. Sorted by
   * user_workspace_preferences.workspaceOrder; missing ids fall back to
   * createdAt ASC. Stale ids (deleted workspaces) are filtered at read time.
   */
  async findAll(params: { userId: string; tenantId: string }): Promise<WorkspaceResponse[]> {
    const { userId, tenantId } = params;
    const privateEnabled = await this.tenantService.isPrivateWorkspaceEnabled(tenantId);

    const [rows, pref] = await Promise.all([
      db
        .select(workspaceBaseFields)
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId))
        )
        .where(and(eq(workspaces.tenantId, tenantId), privateEnabled ? undefined : ne(workspaces.type, 'private')))
        .orderBy(asc(workspaces.createdAt)),
      db
        .select({ order: userWorkspacePreferences.workspaceOrder })
        .from(userWorkspacePreferences)
        .where(eq(userWorkspacePreferences.userId, userId))
        .then((r) => r[0]?.order ?? []),
    ]);

    return applyUserOrder(await this.attachCounts(rows), pref);
  }

  /**
   * Returns every shared workspace in the tenant plus the admin's own private
   * workspace — for the admin-overview settings page. Caller must have
   * can_manage_workspaces (enforced at controller). Other users' private
   * workspaces are intentionally invisible to admins.
   */
  async findAllForAdmin(tenantId: string, adminUserId: string): Promise<WorkspaceResponse[]> {
    const privateEnabled = await this.tenantService.isPrivateWorkspaceEnabled(tenantId);
    const rows = await db
      .select(workspaceBaseFields)
      .from(workspaces)
      .where(
        and(
          eq(workspaces.tenantId, tenantId),
          or(eq(workspaces.type, 'shared'), privateEnabled ? eq(workspaces.ownerId, adminUserId) : undefined)
        )
      )
      .orderBy(asc(workspaces.createdAt));
    return this.attachCounts(rows);
  }

  async findOne(params: WorkspaceAccessParams): Promise<WorkspaceResponse> {
    const { workspaceId, userId, tenantId, canManageWorkspaces } = params;
    const base = await this.findOneBase(workspaceId, tenantId);
    if (base.type === 'private' && !(await this.tenantService.isPrivateWorkspaceEnabled(tenantId))) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    // Admin bypass applies only to shared workspaces. Private workspaces are
    // visible exclusively to their owner; admins do not get a back door.
    const adminBypass = canManageWorkspaces && base.type === 'shared';
    if (!adminBypass && !(await this.isMember(workspaceId, userId))) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    const [withCounts] = await this.attachCounts([base]);
    return withCounts;
  }

  private async findOneBase(workspaceId: string, tenantId: string): Promise<WorkspaceBaseRow> {
    const [row] = await db
      .select(workspaceBaseFields)
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.tenantId, tenantId)));
    if (!row) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    return row;
  }

  async create(dto: CreateWorkspaceDto, tenantId: string, creatorUserId: string): Promise<WorkspaceResponse> {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('name is required');

    const id = crypto.randomUUID();
    const now = new Date();

    // Insert workspace + auto-add creator as member so it shows in their sidebar.
    await db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id,
        tenantId,
        type: 'shared',
        name,
        description: dto.description ?? null,
      });
      await tx.insert(workspaceMembers).values({ workspaceId: id, userId: creatorUserId });
    });

    return {
      id,
      tenantId,
      type: 'shared',
      ownerId: null,
      name,
      description: dto.description ?? null,
      createdAt: now,
      updatedAt: now,
      memberCount: 1,
      projectCount: 0,
    };
  }

  /**
   * Idempotent provisioning of a user's private workspace in a tenant.
   * Called on every `getOrCreateUser` so the invariant "every (user, tenant)
   * has exactly one private workspace" self-heals. The partial unique index
   * on (tenant_id, owner_id) WHERE owner_id IS NOT NULL guarantees at most
   * one row will ever exist for the pair, even under concurrent requests.
   */
  async ensurePrivateWorkspace(userId: string, tenantId: string): Promise<void> {
    if (!(await this.tenantService.isPrivateWorkspaceEnabled(tenantId))) return;

    const id = crypto.randomUUID();

    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(workspaces)
        .values({
          id,
          tenantId,
          type: 'private',
          ownerId: userId,
          name: PRIVATE_WORKSPACE_NAME,
        })
        .onConflictDoNothing({
          target: [workspaces.tenantId, workspaces.ownerId],
          where: sql`${workspaces.ownerId} is not null`,
        })
        .returning({ id: workspaces.id });

      if (inserted.length === 0) return;

      await tx.insert(workspaceMembers).values({ workspaceId: inserted[0].id, userId }).onConflictDoNothing();
    });
  }

  /**
   * Private workspaces are not mutable through the workspace API — they
   * cannot be renamed, deleted, or have members added/removed. The owner
   * relationship is fixed at creation; cleanup happens via user-level
   * CASCADE deletes. UI hides these controls; this guard is the server-side
   * backstop.
   */
  private assertMutable(workspace: WorkspaceBaseRow): void {
    if (workspace.type === 'private') {
      throw new BadRequestException('Private workspace cannot be modified');
    }
  }

  async update(workspaceId: string, dto: UpdateWorkspaceDto, tenantId: string): Promise<WorkspaceResponse> {
    const base = await this.findOneBase(workspaceId, tenantId);
    this.assertMutable(base);

    const updates: Partial<typeof workspaces.$inferInsert> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      updates.name = name;
    }
    if (dto.description !== undefined) updates.description = dto.description;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();

      await db
        .update(workspaces)
        .set(updates)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.tenantId, tenantId)));
    }

    const refreshed = await this.findOneBase(workspaceId, tenantId);
    const [withCounts] = await this.attachCounts([refreshed]);
    return withCounts;
  }

  async remove(workspaceId: string, tenantId: string): Promise<void> {
    const base = await this.findOneBase(workspaceId, tenantId);
    this.assertMutable(base);

    await db.delete(workspaces).where(and(eq(workspaces.id, workspaceId), eq(workspaces.tenantId, tenantId)));
  }

  async listMembers(params: WorkspaceAccessParams): Promise<UserRecord[]> {
    await this.findOne(params);
    return db
      .select()
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, params.workspaceId))
      .orderBy(users.displayName)
      .then((rows) => rows.map((r) => r.users));
  }

  async addMember(workspaceId: string, userId: string, tenantId: string): Promise<void> {
    const [base, [u]] = await Promise.all([
      this.findOneBase(workspaceId, tenantId),
      db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    ]);
    this.assertMutable(base);
    if (!u) throw new NotFoundException(`User ${userId} not found`);

    await db.insert(workspaceMembers).values({ workspaceId, userId }).onConflictDoNothing();
  }

  async removeMember(workspaceId: string, userId: string, tenantId: string): Promise<void> {
    const base = await this.findOneBase(workspaceId, tenantId);
    this.assertMutable(base);

    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  }

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const rows = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    return rows.length > 0;
  }

  async listProjects(params: WorkspaceAccessParams): Promise<ProjectResponse[]> {
    await this.findOne(params);
    return this.projectService.findAllInWorkspace(params.tenantId, params.workspaceId);
  }

  async listFolders(params: WorkspaceAccessParams): Promise<FolderResponse[]> {
    await this.findOne(params);
    return db
      .select({
        id: folders.id,
        workspaceId: folders.workspaceId,
        name: folders.name,
        createdAt: folders.createdAt,
        updatedAt: folders.updatedAt,
        projectCount: sql<number>`count(${projects.id})::int`,
      })
      .from(folders)
      .leftJoin(projects, eq(projects.folderId, folders.id))
      .where(eq(folders.workspaceId, params.workspaceId))
      .groupBy(folders.id)
      .orderBy(asc(sql`lower(${folders.name})`));
  }

  async createFolder(params: WorkspaceAccessParams & { dto: CreateFolderDto }): Promise<FolderResponse> {
    const name = requireFolderName(params.dto.name);
    await this.findOne(params);

    const id = crypto.randomUUID();
    const [row] = await withFolderNameConflict(folderExistsHereMessage(name), () =>
      db.insert(folders).values({ id, workspaceId: params.workspaceId, name }).returning()
    );
    return { ...row, projectCount: 0 };
  }

  async renameFolder(
    params: WorkspaceAccessParams & { folderId: string; dto: RenameFolderDto }
  ): Promise<FolderResponse> {
    const name = requireFolderName(params.dto.name);
    await this.findOne(params);

    const [row] = await withFolderNameConflict(folderExistsHereMessage(name), () =>
      db
        .update(folders)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(folders.id, params.folderId), eq(folders.workspaceId, params.workspaceId)))
        .returning()
    );
    if (!row) throw new NotFoundException(`Folder ${params.folderId} not found`);

    const [{ projectCount }] = await db
      .select({ projectCount: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.folderId, row.id), isNull(projects.kind)));
    return { ...row, projectCount };
  }

  async deleteFolder(params: WorkspaceAccessParams & { folderId: string }): Promise<void> {
    await this.findOne(params);

    const deleted = await db
      .delete(folders)
      .where(and(eq(folders.id, params.folderId), eq(folders.workspaceId, params.workspaceId)))
      .returning({ id: folders.id });
    if (deleted.length === 0) throw new NotFoundException(`Folder ${params.folderId} not found`);
  }

  async moveFolder(
    params: WorkspaceAccessParams & {
      folderId: string;
      toWorkspaceId: string;
      canMoveProjectsBetweenWorkspaces: boolean;
    }
  ): Promise<FolderResponse> {
    const {
      workspaceId,
      folderId,
      toWorkspaceId,
      tenantId,
      userId,
      canManageWorkspaces,
      canMoveProjectsBetweenWorkspaces,
    } = params;

    await this.findOne(params);

    const [folder] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)));
    if (!folder) throw new NotFoundException(`Folder ${folderId} not found`);

    if (toWorkspaceId === workspaceId) {
      return { ...folder, projectCount: await this.countFolderProjects(folder.id) };
    }

    const target = await this.findOneBase(toWorkspaceId, tenantId);
    if (target.type === 'private') {
      throw new ForbiddenException('A folder cannot be moved into a personal workspace');
    }

    await this.assertMoveAllowed({
      target,
      sourceWorkspaceId: workspaceId,
      isCrossWorkspace: true,
      userId,
      canManageWorkspaces,
      canMoveProjectsBetweenWorkspaces,
    });

    const now = new Date();
    const [moved] = await withFolderNameConflict(
      `A folder named "${folder.name}" already exists in the destination workspace`,
      () =>
        db.transaction(async (tx) => {
          const rows = await tx
            .update(folders)
            .set({ workspaceId: toWorkspaceId, updatedAt: now })
            .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
            .returning();
          await tx
            .update(projects)
            .set({ workspaceId: toWorkspaceId, updatedAt: now })
            .where(and(eq(projects.folderId, folderId), eq(projects.workspaceId, workspaceId)));
          return rows;
        })
    );

    return { ...moved, projectCount: await this.countFolderProjects(moved.id) };
  }

  private async countFolderProjects(folderId: string): Promise<number> {
    const [{ projectCount }] = await db
      .select({ projectCount: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.folderId, folderId), isNull(projects.kind)));
    return projectCount;
  }

  async assignProject(params: {
    workspaceId: string | null;
    projectId: string;
    folderId?: string | null;
    tenantId: string;
    userId: string;
    canManageWorkspaces: boolean;
    canMoveProjectsBetweenWorkspaces: boolean;
  }): Promise<ProjectResponse> {
    const { workspaceId, projectId, tenantId, userId, canManageWorkspaces, canMoveProjectsBetweenWorkspaces } = params;

    if (workspaceId === null && !canManageWorkspaces) {
      throw new ForbiddenException(`Missing permission: ${Perms.manageWorkspaces}`);
    }

    const project = canManageWorkspaces
      ? await this.projectService.findOneUnlessHidden(projectId, tenantId, userId)
      : await this.projectService.findOneForUser({ projectId, tenantId, userId });

    const keepsWorkspace = workspaceId === project.workspaceId;

    if (workspaceId !== null) {
      const target = await this.findOneBase(workspaceId, tenantId);

      if (target.type === 'private' && project.workspaceId !== workspaceId) {
        throw new ForbiddenException("Public and workspace projects can't be made private");
      }

      await this.assertMoveAllowed({
        target,
        sourceWorkspaceId: project.workspaceId,
        isCrossWorkspace: !keepsWorkspace,
        userId,
        canManageWorkspaces,
        canMoveProjectsBetweenWorkspaces,
      });
    }

    let folderId: string | null;
    if (params.folderId === undefined) {
      folderId = keepsWorkspace ? project.folderId : null;
    } else {
      folderId = params.folderId;
      if (folderId !== null) {
        if (workspaceId === null) {
          throw new BadRequestException('Public projects cannot be filed into a folder');
        }
        await this.assertFolderInWorkspace(folderId, workspaceId);
      }
    }

    const now = new Date();
    await db
      .update(projects)
      .set({ workspaceId, folderId, updatedAt: now })
      .where(and(eq(projects.id, project.id), eq(projects.tenantId, tenantId)));

    return { ...project, workspaceId, folderId, updatedAt: now };
  }

  private async assertFolderInWorkspace(folderId: string, workspaceId: string): Promise<void> {
    const [folder] = await db
      .select({ workspaceId: folders.workspaceId })
      .from(folders)
      .where(eq(folders.id, folderId));
    if (!folder || folder.workspaceId !== workspaceId) {
      throw new BadRequestException('Folder does not belong to this workspace');
    }
  }

  private async assertMoveAllowed(params: {
    target: WorkspaceBaseRow;
    sourceWorkspaceId: string | null;
    isCrossWorkspace: boolean;
    userId: string;
    canManageWorkspaces: boolean;
    canMoveProjectsBetweenWorkspaces: boolean;
  }): Promise<void> {
    const {
      target,
      sourceWorkspaceId,
      isCrossWorkspace,
      userId,
      canManageWorkspaces,
      canMoveProjectsBetweenWorkspaces,
    } = params;

    const sourceOwnedByCaller = await this.isOwnedByUser(sourceWorkspaceId, userId);
    const targetOwnedByCaller = target.ownerId === userId;
    const movePermWaived = sourceOwnedByCaller || targetOwnedByCaller;

    if (isCrossWorkspace && !canManageWorkspaces && !movePermWaived && !canMoveProjectsBetweenWorkspaces) {
      throw new ForbiddenException(`Missing permission: ${Perms.moveProjectsBetweenWorkspaces}`);
    }

    const targetVisible = targetOwnedByCaller || (canManageWorkspaces && target.type === 'shared');
    if (!targetVisible && !(await this.isMember(target.id, userId))) {
      throw new NotFoundException(`Workspace ${target.id} not found`);
    }
  }

  private async isOwnedByUser(workspaceId: string | null, userId: string): Promise<boolean> {
    if (!workspaceId) return false;
    const [row] = await db
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.ownerId === userId;
  }

  async createProjectInWorkspace(
    params: WorkspaceAccessParams & { dto?: CreateProjectDto; folderId?: string | null }
  ): Promise<ProjectResponse> {
    await this.findOne(params);
    if (params.folderId != null) {
      await this.assertFolderInWorkspace(params.folderId, params.workspaceId);
    }
    return this.projectService.create(params.dto, params.tenantId, {
      workspaceId: params.workspaceId,
      folderId: params.folderId,
      createdBy: params.userId,
    });
  }

  private async attachCounts(rows: WorkspaceBaseRow[]): Promise<WorkspaceResponse[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [memberRows, projectRows] = await Promise.all([
      db
        .select({ workspaceId: workspaceMembers.workspaceId, count: sql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.workspaceId, ids))
        .groupBy(workspaceMembers.workspaceId),
      db
        .select({ workspaceId: projects.workspaceId, count: sql<number>`count(*)::int` })
        .from(projects)
        .where(and(inArray(projects.workspaceId, ids), isNull(projects.kind)))
        .groupBy(projects.workspaceId),
    ]);

    const memberCountByWs = new Map(memberRows.map((r) => [r.workspaceId, r.count]));
    const projectCountByWs = new Map(
      projectRows.flatMap((r) => (r.workspaceId === null ? [] : [[r.workspaceId, r.count] as const]))
    );

    return rows.map((r) => ({
      ...r,
      memberCount: memberCountByWs.get(r.id) ?? 0,
      projectCount: projectCountByWs.get(r.id) ?? 0,
    }));
  }
}

function requireFolderName(raw: string | undefined): string {
  const name = raw?.trim();
  if (!name) throw new BadRequestException('name is required');
  return name;
}

function folderExistsHereMessage(name: string): string {
  return `A folder named "${name}" already exists in this workspace`;
}

async function withFolderNameConflict<T>(conflictMessage: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isFolderNameConflict(err)) {
      throw new ConflictException(conflictMessage);
    }
    throw err;
  }
}

function isFolderNameConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (matchesFolderUniqueViolation(err)) return true;
  return (
    'cause' in err && typeof err.cause === 'object' && err.cause !== null && matchesFolderUniqueViolation(err.cause)
  );
}

function matchesFolderUniqueViolation(err: object): boolean {
  if (!('code' in err) || !('constraint_name' in err)) return false;
  return err.code === '23505' && err.constraint_name === FOLDERS_WORKSPACE_NAME_CI_UNIQUE;
}

function applyUserOrder<T extends { id: string }>(rows: T[], order: string[]): T[] {
  if (order.length === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const ordered: T[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (row) {
      ordered.push(row);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

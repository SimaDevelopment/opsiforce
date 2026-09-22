import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Perms } from '../../permission/permission.constants';
import { TenantService } from '../../tenant/tenant.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import type { WorkspaceAccessParams } from '../../workspace/workspace.types';
import type { Caller } from '../auth/caller';
import type { ValidationErrorItem } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';
import { ProjectPlacementRepository } from './project-placement.repository';
import type { CreateProject } from './projects.schema';

export interface ProjectPlacement {
  workspaceId: string | null;
  folderId: string | null;
}

type WorkspaceAccess = Omit<WorkspaceAccessParams, 'workspaceId'>;

const REFERENCE_LABELS = { agentId: 'Agent', workspaceId: 'Workspace', folderId: 'Folder' } as const;

function unknownReference(field: keyof typeof REFERENCE_LABELS, id: string): ValidationErrorItem {
  return {
    detail: `No ${REFERENCE_LABELS[field]} with id "${id}" is available here`,
    pointer: `#/${field}`,
    in: 'body',
  };
}

@Injectable()
export class ProjectPlacementService {
  constructor(
    private readonly repository: ProjectPlacementRepository,
    private readonly workspaces: WorkspaceService,
    private readonly tenants: TenantService
  ) {}

  async resolve(caller: Caller, body: CreateProject): Promise<ProjectPlacement> {
    const access: WorkspaceAccess = {
      tenantId: caller.organization.id,
      userId: caller.user.platformId,
      canManageWorkspaces: caller.permissions.has(Perms.manageWorkspaces),
    };
    const privateWorkspacesEnabled = await this.tenants.isPrivateWorkspaceEnabled(access.tenantId);
    const personalIsDefault = caller.user.kind === 'user' && privateWorkspacesEnabled;
    const named = body.workspaceId;
    const errors: ValidationErrorItem[] = [];

    if (!(await this.repository.agentIsLive(body.agentId, access.tenantId, access.userId))) {
      errors.push(unknownReference('agentId', body.agentId));
    }

    const namedWorkspaceId = named === undefined ? null : await this.visibleWorkspaceId(named, access);
    if (named !== undefined && namedWorkspaceId === null) {
      errors.push(unknownReference('workspaceId', named));
    }

    const workspaceId =
      named === undefined && personalIsDefault
        ? await this.repository.findPersonalWorkspaceId(access.tenantId, access.userId)
        : namedWorkspaceId;

    if (body.folderId !== undefined) {
      const folderWorkspaceId = await this.repository.findFolderWorkspaceId(body.folderId);
      if (folderWorkspaceId === null || folderWorkspaceId !== workspaceId) {
        errors.push(unknownReference('folderId', body.folderId));
      }
    }

    if (errors.length > 0) throw Errors.invalidReference(errors);

    const folderId = body.folderId ?? null;
    if (named !== undefined) return { workspaceId: namedWorkspaceId, folderId };
    if (personalIsDefault) return { workspaceId: await this.ensurePersonalWorkspaceId(access), folderId };
    return { workspaceId: null, folderId };
  }

  private async visibleWorkspaceId(workspaceId: string, access: WorkspaceAccess): Promise<string | null> {
    try {
      const workspace = await this.workspaces.findOne({ ...access, workspaceId });
      return workspace.id;
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async ensurePersonalWorkspaceId(access: WorkspaceAccess): Promise<string> {
    await this.workspaces.ensurePrivateWorkspace(access.userId, access.tenantId);
    const workspaceId = await this.repository.findPersonalWorkspaceId(access.tenantId, access.userId);
    if (workspaceId === null) {
      throw new InternalServerErrorException(`No Personal workspace for user ${access.userId}`);
    }
    return workspaceId;
  }
}

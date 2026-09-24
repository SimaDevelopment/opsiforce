import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AgentConnectionService } from '../../agent-session/agent-connection.service';
import type { ChatRow } from '../../builder/builder-chat.repository';
import { BuilderChatService } from '../../builder/builder-chat.service';
import { Perms } from '../../permission/permission.constants';
import { AgentStatusService } from '../../project/agent-status.service';
import { ProjectService } from '../../project/project.service';
import { isChatKind, TEST_PROJECT_KIND } from '../../project/project.types';
import { ProjectEnvironmentService } from '../../project-environment/project-environment.service';
import { chatProjectIdOf, type Caller } from '../auth/caller';
import { mappingAgentErrors } from '../errors/agent-error.mapper';
import { Errors } from '../errors/public-api-error';
import { ProjectPlacementService } from './project-placement.service';
import { ProjectMapper } from './projects.mapper';
import { PublicProjectsRepository, type ProjectRow, type ProjectScope } from './projects.repository';
import type { ConnectionDto, CreateProject, ProjectDto, ProjectListQuery, ProjectPageDto } from './projects.schema';

function scopeOf(caller: Caller): ProjectScope {
  return {
    tenantId: caller.organization.id,
    userId: caller.user.platformId,
    ...(caller.projectId === undefined ? {} : { createdByProjectId: caller.projectId }),
  };
}

@Injectable()
export class PublicProjectsService {
  constructor(
    private readonly repository: PublicProjectsRepository,
    private readonly agentStatus: AgentStatusService,
    private readonly placement: ProjectPlacementService,
    private readonly projects: ProjectService,
    private readonly environments: ProjectEnvironmentService,
    private readonly connections: AgentConnectionService,
    private readonly builderChats: BuilderChatService
  ) {}

  async list(caller: Caller, query: ProjectListQuery): Promise<ProjectPageDto> {
    const page = await this.repository.page(scopeOf(caller), query);
    return { items: await this.toDtos(page.rows), nextCursor: page.nextCursor };
  }

  async findVisible(caller: Caller, projectId: string): Promise<ProjectDto | null> {
    const project = await this.findReachable(caller, projectId);
    if (!project) return null;
    const [dto] = await this.toDtos([project]);
    return dto;
  }

  async create(caller: Caller, body: CreateProject): Promise<ProjectDto> {
    const chat = body.kind === undefined ? null : await this.requireCallingBuilderChat(caller);
    const placement = await this.placement.resolve(caller, body);
    if (chat) await this.builderChats.deleteTestProjectsOf(caller.organization.id, chat.id);

    const created = await this.projects.create(
      { title: body.title, description: body.description, timezone: body.timezone, agentId: body.agentId },
      caller.organization.id,
      {
        // ADR-0064 keeps a test Project out of every workspace, so placement applies only to ordinary ones.
        ...(chat ? { kind: TEST_PROJECT_KIND } : { workspaceId: placement.workspaceId, folderId: placement.folderId }),
        createdBy: caller.user.platformId,
        createdByProjectId: caller.projectId ?? null,
      }
    );

    const row = await this.repository.findById(created.id);
    if (!row) throw new InternalServerErrorException(`Project ${created.id} vanished right after creation`);
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async connect(
    caller: Caller,
    projectId: string,
    environmentId: string,
    signal?: AbortSignal
  ): Promise<ConnectionDto> {
    await this.requireVisible(caller, projectId);

    const environment = await this.environments.findByIdOrNull(environmentId);
    if (!environment || environment.projectId !== projectId) throw Errors.projectNotFound();

    const { baseUrl, openapiUrl, sessionId, build } = await mappingAgentErrors(() =>
      this.connections.connect(environment, { signal })
    );

    return { baseUrl, openapiUrl, sessionId, build };
  }

  async requireVisible(caller: Caller, projectId: string): Promise<ProjectRow> {
    const project = await this.findReachable(caller, projectId);
    if (!project) throw Errors.projectNotFound();
    return project;
  }

  private async findReachable(caller: Caller, projectId: string): Promise<ProjectRow | null> {
    const scope = scopeOf(caller);
    return (
      (await this.repository.findVisible(scope, projectId)) ?? this.repository.findReachableHidden(scope, projectId)
    );
  }

  /** Only an Agent Caller whose own Project is a Builder chat may stamp `kind`, and only as `test`. */
  private async requireCallingBuilderChat(caller: Caller): Promise<ChatRow> {
    const chatId = chatProjectIdOf(caller);
    const chat = chatId === null ? null : await this.builderChats.findChatRow(caller.organization.id, chatId);
    if (!chat || !isChatKind(chat.kind)) {
      throw Errors.invalidReference([
        {
          detail: 'Only an Agent Caller running a Builder chat may create a test Project',
          pointer: '#/kind',
          in: 'body',
        },
      ]);
    }
    return chat;
  }

  async restart(caller: Caller, projectId: string): Promise<void> {
    const project = await this.requireVisible(caller, projectId);
    if (!caller.permissions.has(Perms.restartProject)) throw Errors.permissionDenied(Perms.restartProject);
    if (project.disabled) throw Errors.environmentDisabled();
    await this.projects.restart(projectId, caller.organization.id);
  }

  async delete(caller: Caller, projectId: string): Promise<void> {
    await this.requireVisible(caller, projectId);
    if (!caller.permissions.has(Perms.deleteProject)) throw Errors.permissionDenied(Perms.deleteProject);
    await this.projects.remove(projectId, caller.organization.id);
  }

  private async toDtos(rows: ProjectRow[]): Promise<ProjectDto[]> {
    const environments = await this.repository.environmentsOf(rows.map((row) => row.id));
    return rows.map((row) =>
      ProjectMapper.toDto(row, environments.get(row.id) ?? [], this.agentStatus.statusOf(row.id))
    );
  }
}

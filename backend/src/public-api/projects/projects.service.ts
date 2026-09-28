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
    tenantId: caller.tenant.id,
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
    if (chat) await this.requireChatMayTest(chat, body.agentId);
    const placement = await this.placement.resolve(caller, body);
    if (chat) await this.refuseSecondTestProject(caller, chat.id);

    const created = await this.projects.create(
      { title: body.title, description: body.description, timezone: body.timezone, agentId: body.agentId },
      caller.tenant.id,
      {
        // ADR-0064 keeps a test Project out of every workspace, so placement applies only to ordinary ones.
        ...(chat ? { kind: TEST_PROJECT_KIND } : { workspaceId: placement.workspaceId, folderId: placement.folderId }),
        createdBy: caller.user.platformId,
        createdByProjectId: caller.projectId ?? null,
      }
    );

    if (chat) await this.keepOnlyFirstTestProject(caller, chat.id, created.id);

    const row = await this.repository.findById(created.id);
    if (!row) throw new InternalServerErrorException(`Project ${created.id} vanished right after creation`);
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async updateTest(caller: Caller, projectId: string): Promise<void> {
    await this.requireOwnedTestProject(caller, projectId);
    await this.projects.updateTestProject(projectId);
  }

  async resetTest(caller: Caller, projectId: string): Promise<void> {
    const project = await this.requireOwnedTestProject(caller, projectId);
    if (project.disabled) throw Errors.environmentDisabled();
    await this.projects.resetTestProject(projectId);
  }

  private async requireOwnedTestProject(caller: Caller, projectId: string): Promise<ProjectRow> {
    const project = await this.requireVisible(caller, projectId);
    const chatId = chatProjectIdOf(caller);
    if (project.kind !== TEST_PROJECT_KIND || chatId === null || project.createdByProjectId !== chatId) {
      throw Errors.notTestProjectOwner();
    }
    return project;
  }

  private async refuseSecondTestProject(caller: Caller, chatId: string): Promise<void> {
    const existing = await this.builderChats.testProjectOf(caller.tenant.id, chatId);
    if (existing) throw Errors.testProjectExists(existing.id);
  }

  private async keepOnlyFirstTestProject(caller: Caller, chatId: string, createdId: string): Promise<void> {
    const first = await this.builderChats.testProjectOf(caller.tenant.id, chatId);
    if (!first || first.id === createdId) return;
    await this.projects.discardHalfCreatedProject(createdId);
    throw Errors.testProjectExists(first.id);
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
    const chat = chatId === null ? null : await this.builderChats.findChatRow(caller.tenant.id, chatId);
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

  /** An Agent chat tests only its own subject; a Skill chat may test its Skill on any Agent. */
  private async requireChatMayTest(chat: ChatRow, agentId: string): Promise<void> {
    if (chat.kind !== 'agent_builder_chat') return;
    const subject = await this.builderChats.subjectRowOf(chat.id);
    if (subject?.type === 'agent' && subject.id === agentId) return;
    throw Errors.invalidReference([
      {
        detail: "An Agent chat's test Project runs only on the chat's own Agent",
        pointer: '#/agentId',
        in: 'body',
      },
    ]);
  }

  async restart(caller: Caller, projectId: string): Promise<void> {
    const project = await this.requireVisible(caller, projectId);
    if (!caller.permissions.has(Perms.restartProject)) throw Errors.permissionDenied(Perms.restartProject);
    if (project.disabled) throw Errors.environmentDisabled();
    await this.projects.restart(projectId, caller.tenant.id);
  }

  async delete(caller: Caller, projectId: string): Promise<void> {
    await this.requireVisible(caller, projectId);
    if (!caller.permissions.has(Perms.deleteProject)) throw Errors.permissionDenied(Perms.deleteProject);
    await this.projects.remove(projectId, caller.tenant.id);
  }

  private async toDtos(rows: ProjectRow[]): Promise<ProjectDto[]> {
    const environments = await this.repository.environmentsOf(rows.map((row) => row.id));
    return rows.map((row) =>
      ProjectMapper.toDto(row, environments.get(row.id) ?? [], this.agentStatus.statusOf(row.id))
    );
  }
}

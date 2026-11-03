import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentConnectionService } from '../../agent-session/agent-connection.service';
import type { ChatRow } from '../../builder/builder-chat.repository';
import { BuilderChatService } from '../../builder/builder-chat.service';
import {
  CREATED_PROJECT_AGENTS,
  CREATED_PROJECTS_WORKSPACE,
  MAX_CREATED_PROJECTS,
  PublicApiSettings,
  type PublicApiSettingValues,
} from '../../external-services/configuration/public-api-settings';
import { AgentStatusService } from '../../project/agent-status.service';
import { callingProjectReachOf } from '../../project/calling-project-reach';
import { ProjectProvenanceRepository } from '../../project/project-provenance.repository';
import { CreatedProjectsCapReached, type CreatedProjectsCap } from '../../project/project-limit';
import { MAX_PROJECT_CHAIN_DEPTH } from '../../project/project.constants';
import { ProjectService } from '../../project/project.service';
import { isChatKind, TEST_PROJECT_KIND } from '../../project/project.types';
import { ProjectEnvironmentService } from '../../project-environment/project-environment.service';
import { PublicUrlService } from '../../project-environment/public-url.service';
import { callingEnvironmentOf, chatProjectIdOf, type Caller } from '../auth/caller';
import { mappingAgentErrors } from '../errors/agent-error.mapper';
import { Errors } from '../errors/public-api-error';
import { ProjectPlacementService } from './project-placement.service';
import { ProjectMapper } from './projects.mapper';
import { PublicProjectsRepository, type ProjectRow, type ProjectScope } from './projects.repository';
import type { ConnectionDto, CreateProject, ProjectDto, ProjectListQuery, ProjectPageDto } from './projects.schema';

interface CallingSettings {
  projectId: string;
  settings: PublicApiSettingValues | null;
}

@Injectable()
export class PublicProjectsService {
  private readonly runtimeProxyUrl: string;

  constructor(
    private readonly repository: PublicProjectsRepository,
    private readonly agentStatus: AgentStatusService,
    private readonly placement: ProjectPlacementService,
    private readonly projects: ProjectService,
    private readonly environments: ProjectEnvironmentService,
    private readonly connections: AgentConnectionService,
    private readonly builderChats: BuilderChatService,
    private readonly provenance: ProjectProvenanceRepository,
    private readonly publicApiSettings: PublicApiSettings,
    private readonly publicUrls: PublicUrlService,
    config: ConfigService
  ) {
    this.runtimeProxyUrl = config.get<string>('runtimeProxyUrl', '').replace(/\/+$/, '');
  }

  async list(caller: Caller, query: ProjectListQuery): Promise<ProjectPageDto> {
    const page = await this.repository.page(await this.scopeOf(caller), query);
    return { items: await this.toDtos(caller, page.rows), nextCursor: page.nextCursor };
  }

  async get(caller: Caller, projectId: string): Promise<ProjectDto> {
    const [dto] = await this.toDtos(caller, [await this.requireVisible(caller, projectId)]);
    return dto;
  }

  async create(caller: Caller, body: CreateProject): Promise<ProjectDto> {
    await this.refuseChainTooDeep(caller);
    const calling = await this.callingSettingsOf(caller);
    const createdProjectsCap: CreatedProjectsCap | null = calling && {
      creatingProjectId: calling.projectId,
      max: this.publicApiSettings.limitOf(calling.settings, MAX_CREATED_PROJECTS),
    };
    const chat = body.kind === undefined ? null : await this.requireCallingBuilderChat(caller);
    if (chat) await this.requireChatMayTest(chat, body.agentId);
    const placed =
      body.kind === undefined && calling ? await this.withinCreatedProjectRules(caller, calling.settings, body) : body;
    const placement = await this.placement.resolve(caller, placed);
    if (chat) await this.refuseSecondTestProject(caller, chat.id);

    const created = await this.projects
      .create(
        { title: body.title, description: body.description, timezone: body.timezone, agentId: body.agentId },
        caller.tenant.id,
        {
          // ADR-0064 keeps a test Project out of every workspace, so placement applies only to ordinary ones.
          ...(chat
            ? { kind: TEST_PROJECT_KIND }
            : { workspaceId: placement.workspaceId, folderId: placement.folderId }),
          createdBy: caller.user.platformId,
          createdByProjectId: caller.projectId ?? null,
          createdProjectsCap,
        }
      )
      .catch((error: unknown) => {
        if (error instanceof CreatedProjectsCapReached) {
          throw Errors.maxCreatedProjects(error.max, this.publicApiSettings.labelOf(MAX_CREATED_PROJECTS));
        }
        throw error;
      });

    if (chat) await this.keepOnlyFirstTestProject(caller, chat.id, created.id);

    const row = await this.repository.findById(created.id);
    if (!row) throw new InternalServerErrorException(`Project ${created.id} vanished right after creation`);
    const [dto] = await this.toDtos(caller, [row]);
    return dto;
  }

  private async refuseChainTooDeep(caller: Caller): Promise<void> {
    const callingProjectId = chatProjectIdOf(caller);
    if (callingProjectId === null) return;
    if ((await this.provenance.chainDepth(callingProjectId)) >= MAX_PROJECT_CHAIN_DEPTH) {
      throw Errors.chainTooDeep(MAX_PROJECT_CHAIN_DEPTH);
    }
  }

  private async callingSettingsOf(caller: Caller): Promise<CallingSettings | null> {
    const calling = callingEnvironmentOf(caller);
    if (!calling) return null;
    return { projectId: calling.projectId, settings: await this.publicApiSettings.of(calling.projectEnvironmentId) };
  }

  private async withinCreatedProjectRules(
    caller: Caller,
    settings: PublicApiSettingValues | null,
    body: CreateProject
  ): Promise<CreateProject> {
    const agents = settings?.[CREATED_PROJECT_AGENTS] ?? [];
    if (agents.length > 0 && !agents.includes(body.agentId)) {
      throw Errors.notAllowedBy(
        CREATED_PROJECT_AGENTS,
        `This Project may create Projects only of the Agents listed under "${this.publicApiSettings.labelOf(CREATED_PROJECT_AGENTS)}". Pick one of those, or ask someone who can configure this Project's External Services to add the Agent.`
      );
    }
    const workspaceId = settings?.[CREATED_PROJECTS_WORKSPACE] ?? null;
    if (workspaceId === null || body.workspaceId === workspaceId) return body;
    const setting = `"${this.publicApiSettings.labelOf(CREATED_PROJECTS_WORKSPACE)}"`;
    if (body.workspaceId !== undefined) {
      throw Errors.notAllowedBy(
        CREATED_PROJECTS_WORKSPACE,
        `This Project puts the Projects it creates in the Workspace chosen under ${setting}. Leave workspaceId out, or ask someone who can configure this Project's External Services to change it.`
      );
    }
    if (!(await this.placement.isMemberOf(caller, workspaceId))) {
      throw Errors.notAllowedBy(
        CREATED_PROJECTS_WORKSPACE,
        `The person who created this Project is not a member of the Workspace chosen under ${setting}. Ask someone who can configure this Project's External Services to change it.`
      );
    }
    return { ...body, workspaceId };
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

    const origin = this.runtimeOriginFor(caller);
    return { baseUrl: `${origin}${baseUrl}`, openapiUrl: `${origin}${openapiUrl}`, sessionId, build };
  }

  private runtimeOriginFor(caller: Caller): string {
    return caller.source === 'caller-identity' ? this.runtimeProxyUrl : '';
  }

  async requireVisible(caller: Caller, projectId: string): Promise<ProjectRow> {
    const project = await this.findReachable(caller, projectId);
    if (project) return project;
    throw Errors.projectNotFound(
      caller.projectId === undefined ? undefined : this.publicApiSettings.unreachedProjectDetail()
    );
  }

  private async scopeOf(caller: Caller): Promise<ProjectScope> {
    const scope = { tenantId: caller.tenant.id, userId: caller.user.platformId };
    if (caller.projectId === undefined) return scope;
    const settings = caller.projectEnvironmentId ? await this.publicApiSettings.of(caller.projectEnvironmentId) : null;
    return { ...scope, callingProject: callingProjectReachOf(caller.projectId, settings) };
  }

  private async findReachable(caller: Caller, projectId: string): Promise<ProjectRow | null> {
    const scope = await this.scopeOf(caller);
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
    if (!caller.permissions.has('can_restart_project')) throw Errors.permissionDenied('can_restart_project');
    if (project.disabled) throw Errors.environmentDisabled();
    await this.projects.restart(projectId, caller.tenant.id);
  }

  async delete(caller: Caller, projectId: string): Promise<void> {
    const project = await this.requireVisible(caller, projectId);
    if (caller.projectId !== undefined && project.createdByProjectId !== caller.projectId) {
      throw Errors.outsideCallingProject(this.publicApiSettings.otherProjectNotDeletedDetail());
    }
    if (!caller.permissions.has('can_delete_project')) throw Errors.permissionDenied('can_delete_project');
    await this.projects.remove(projectId, caller.tenant.id);
  }

  private async toDtos(caller: Caller, rows: ProjectRow[]): Promise<ProjectDto[]> {
    const environments = await this.repository.environmentsOf(rows.map((row) => row.id));
    const runtimeOrigin = this.runtimeOriginFor(caller);
    return rows.map((row) =>
      ProjectMapper.toDto(
        row,
        environments.get(row.id) ?? [],
        { agentStatus: this.agentStatus.statusOf(row.id), waitingForInput: this.agentStatus.waitingForInput(row.id) },
        this.publicUrls,
        runtimeOrigin
      )
    );
  }
}

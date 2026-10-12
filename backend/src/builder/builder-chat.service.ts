import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { defaultOperationSwitches } from '@opsiforce/external-service-sdk/platform';
import { AgentService } from '../agent/agent.service';
import { canEditAgent, findVisibleAgent } from '../agent/agent-visibility';
import { PUBLIC_API_SERVICE } from '../external-services/configuration/operation-switches';
import { ProjectConfigurationStore } from '../external-services/configuration/project-configuration.store';
import { ServiceRegistry } from '../external-services/registry/service-registry';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { Perms } from '../permission/permission.constants';
import { ProjectService } from '../project/project.service';
import { EXTERNAL_SERVICE_CHAT_KIND, ProjectStatus, type ChatKind } from '../project/project.types';
import { canEditSkill, findVisibleSkill } from '../store/skill-visibility';
import {
  BuilderChatRepository,
  type ChatRow,
  type ClaimableSubjectRow,
  type SubjectRow,
  type TestProjectRow,
} from './builder-chat.repository';
import type {
  BuilderChatCaller,
  BuilderChatSummary,
  BuilderSubject,
  BuilderSubjectRef,
  BuilderSubjectType,
} from './builder.types';

const CHAT_KIND_OF: Record<BuilderSubjectType, ChatKind> = {
  agent: 'agent_builder_chat',
  skill: 'skill_builder_chat',
  external_service: EXTERNAL_SERVICE_CHAT_KIND,
};

export const BUILDER_CHAT_PUBLIC_API_WRITES = [
  'create_skill',
  'create_skill_version',
  'update_skill',
  'duplicate_skill',
  'update_agent',
  'update_agent_profile',
  'save_agent_template',
  'set_agent_skill',
  'remove_agent_skill',
  'create_project',
  'connect_project',
  'restart_project',
  'update_test_project',
  'reset_test_project',
] as const;

const SUBJECT_NOUN: Record<BuilderSubjectType, string> = {
  agent: 'Agent',
  skill: 'Skill',
  external_service: 'External Service',
};

interface ResolvedSubject extends BuilderSubject {
  builderChatId: string | null;
  editable: boolean;
}

interface SubjectColumns {
  id: string;
  name: string;
  displayName: string | null;
  disabled: boolean;
  builderChatId: string | null;
}

function subjectFields(type: BuilderSubjectType, row: SubjectColumns): Omit<ResolvedSubject, 'editable'> {
  return {
    type,
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    disabled: row.disabled,
    builderChatId: row.builderChatId,
  };
}

function subjectRowOf(ref: BuilderSubjectRef | undefined): SubjectRow {
  if (ref && 'agentId' in ref && typeof ref.agentId === 'string') return { type: 'agent', id: ref.agentId };
  if (ref && 'skillId' in ref && typeof ref.skillId === 'string') return { type: 'skill', id: ref.skillId };
  if (ref && 'externalServiceId' in ref && typeof ref.externalServiceId === 'string') {
    return { type: 'external_service', id: ref.externalServiceId };
  }
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'A Builder chat is opened for an agentId, a skillId or an externalServiceId',
  });
}

function isClaimable(target: SubjectRow): target is ClaimableSubjectRow {
  return target.type !== 'external_service';
}

function requirePermissionFor(caller: BuilderChatCaller, type: BuilderSubjectType): void {
  if (type === 'agent' && !caller.canManageAgents) throw new MissingPermissionException(Perms.manageAgents);
  if (type === 'skill' && !caller.canManageSkills) throw new MissingPermissionException(Perms.manageSkills);
  if (type === 'external_service' && !caller.canManageTenantExternalServices) {
    throw new MissingPermissionException(Perms.manageTenantExternalServices);
  }
}

@Injectable()
export class BuilderChatService {
  constructor(
    private readonly repository: BuilderChatRepository,
    private readonly projects: ProjectService,
    private readonly agents: AgentService,
    private readonly registry: ServiceRegistry,
    private readonly projectConfigurationStore: ProjectConfigurationStore
  ) {}

  async openFor(caller: BuilderChatCaller, ref: BuilderSubjectRef): Promise<BuilderChatSummary> {
    const target = subjectRowOf(ref);
    const subject = await this.requireEditableSubject(caller, target);
    const existing = await this.existingChat(caller.tenantId, subject);
    if (existing) return this.summarize(await this.enableWithSubject(caller.tenantId, existing, subject), subject);
    if (!isClaimable(target)) throw new NotFoundException(`External Service ${target.id} has no builder chat`);

    if (subject.disabled) {
      throw new BadRequestException({
        code: 'subject_disabled',
        message: `Enable \`${subject.name}\` before opening the Builder on it`,
      });
    }

    const agentId = await this.agents.findBuilderAgentId();
    if (!agentId) {
      throw new ServiceUnavailableException('The Skill & Agent Builder is not installed on this deployment');
    }

    const project = await this.projects.create(
      { title: `Builder: ${subject.displayName ?? subject.name}`, agentId },
      caller.tenantId,
      {
        createdBy: caller.userId,
        kind: CHAT_KIND_OF[subject.type],
        builderSubjectAgentId: subject.type === 'agent' ? subject.id : null,
        configureBeforeDelivery: (chatId) => this.startWithPublicApi(chatId),
      }
    );
    if (await this.repository.claim(target, project.id)) {
      return this.summarize(await this.requireChatRow(caller.tenantId, project.id), subject);
    }

    await this.projects.discardHalfCreatedProject(project.id);
    const winner = await this.existingChat(caller.tenantId, await this.requireEditableSubject(caller, target));
    if (!winner) throw new ConflictException('The Builder chat could not be opened; try again');
    return this.summarize(winner, subject);
  }

  private async startWithPublicApi(chatId: string): Promise<void> {
    const service = this.registry.bySlug(PUBLIC_API_SERVICE);
    if (!service) {
      throw new ServiceUnavailableException(
        `The ${PUBLIC_API_SERVICE} External Service is not registered, so a Builder chat could not reach the platform`
      );
    }
    await this.projectConfigurationStore.startWith(service, chatId, {
      ...defaultOperationSwitches(service.manifest),
      ...Object.fromEntries(BUILDER_CHAT_PUBLIC_API_WRITES.map((operation) => [operation, true])),
    });
  }

  /** The chat's one Test Project; null when `chatId` is not a Builder chat or has none yet. */
  async testProjectOf(tenantId: string, chatId: string): Promise<{ id: string } | null> {
    const chat = await this.repository.findChat(tenantId, chatId);
    if (!chat) return null;
    const [test] = await this.repository.testProjectsOf(chat.id);
    return test ? { id: test.id } : null;
  }

  async findChatRow(tenantId: string, chatId: string): Promise<ChatRow | null> {
    return this.repository.findChat(tenantId, chatId);
  }

  async subjectRowOf(chatId: string): Promise<SubjectRow | null> {
    return this.repository.subjectOf(chatId);
  }

  async subjectOfChat(tenantId: string, userId: string, chatId: string): Promise<BuilderSubject | null> {
    const chat = await this.repository.findChat(tenantId, chatId);
    const target = chat && (await this.repository.subjectOf(chat.id));
    if (!target) return null;
    const subject = await this.readSubject(tenantId, userId, target);
    return subject ? publicSubject(subject) : null;
  }

  private async enableWithSubject(tenantId: string, chat: ChatRow, subject: ResolvedSubject): Promise<ChatRow> {
    if (!chat.disabled || subject.disabled) return chat;
    await this.projects.enable(chat.id, tenantId);
    return this.requireChatRow(tenantId, chat.id);
  }

  private async existingChat(tenantId: string, subject: ResolvedSubject): Promise<ChatRow | null> {
    return subject.builderChatId ? this.repository.findChat(tenantId, subject.builderChatId) : null;
  }

  private async requireChatRow(tenantId: string, chatId: string): Promise<ChatRow> {
    const chat = await this.repository.findChat(tenantId, chatId);
    if (!chat) throw new NotFoundException(`Builder chat ${chatId} not found`);
    return chat;
  }

  private async requireEditableSubject(caller: BuilderChatCaller, target: SubjectRow): Promise<ResolvedSubject> {
    requirePermissionFor(caller, target.type);

    const subject = await this.readSubject(caller.tenantId, caller.userId, target);
    if (!subject) throw new NotFoundException(`${SUBJECT_NOUN[target.type]} ${target.id} not found`);
    if (!subject.editable) {
      throw new ForbiddenException({ code: 'not_editable', message: `\`${subject.name}\` cannot be edited` });
    }
    return subject;
  }

  private async readSubject(tenantId: string, userId: string, target: SubjectRow): Promise<ResolvedSubject | null> {
    if (target.type === 'agent') {
      const agent = await findVisibleAgent(tenantId, userId, target.id);
      return agent ? { ...subjectFields('agent', agent), editable: canEditAgent(agent, userId) } : null;
    }
    if (target.type === 'external_service') {
      const service = await this.repository.findExternalService(tenantId, target.id);
      if (!service) return null;
      return {
        ...subjectFields('external_service', { ...service, name: service.slug, displayName: service.title }),
        editable: true,
      };
    }
    const skill = await findVisibleSkill(tenantId, userId, target.id);
    return skill ? { ...subjectFields('skill', skill), editable: canEditSkill(skill, userId) } : null;
  }

  private async summarize(chat: ChatRow, subject: ResolvedSubject): Promise<BuilderChatSummary> {
    const [test] = await this.repository.testProjectsOf(chat.id);
    return {
      id: chat.id,
      kind: chat.kind,
      subject: publicSubject(subject),
      createdAt: chat.createdAt,
      lastPromptAt: chat.lastPromptAt,
      disabled: chat.disabled,
      ...(test === undefined ? {} : { testProject: { id: test.id, environmentStatus: statusOf(test) } }),
    };
  }
}

function publicSubject(subject: ResolvedSubject): BuilderSubject {
  return {
    type: subject.type,
    id: subject.id,
    name: subject.name,
    displayName: subject.displayName,
    disabled: subject.disabled,
  };
}

function statusOf(row: TestProjectRow): ProjectStatus {
  return row.disabled ? ProjectStatus.Disabled : row.status;
}

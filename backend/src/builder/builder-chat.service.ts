import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { canEditAgent, findVisibleAgent } from '../agent/agent-visibility';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { Perms } from '../permission/permission.constants';
import { ProjectService } from '../project/project.service';
import { ProjectStatus, type ChatKind } from '../project/project.types';
import { canEditSkill, findVisibleSkill } from '../store/skill-visibility';
import { BuilderChatRepository, type ChatRow, type SubjectRow, type TestProjectRow } from './builder-chat.repository';
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
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'A Builder chat is opened for either an agentId or a skillId',
  });
}

@Injectable()
export class BuilderChatService {
  constructor(
    private readonly repository: BuilderChatRepository,
    private readonly projects: ProjectService,
    private readonly agents: AgentService
  ) {}

  async openFor(caller: BuilderChatCaller, ref: BuilderSubjectRef): Promise<BuilderChatSummary> {
    const target = subjectRowOf(ref);
    const subject = await this.requireEditableSubject(caller, target);
    const existing = await this.existingChat(caller.tenantId, subject);
    if (existing) return this.summarize(await this.enableWithSubject(caller.tenantId, existing, subject), subject);

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
    const permission = target.type === 'agent' ? Perms.manageAgents : Perms.manageSkills;
    const permitted = target.type === 'agent' ? caller.canManageAgents : caller.canManageSkills;
    if (!permitted) throw new MissingPermissionException(permission);

    const subject = await this.readSubject(caller.tenantId, caller.userId, target);
    if (!subject) throw new NotFoundException(`${target.type === 'agent' ? 'Agent' : 'Skill'} ${target.id} not found`);
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

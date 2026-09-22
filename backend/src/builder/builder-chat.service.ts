import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { findVisibleAgent } from '../agent/agent-visibility';
import { ProjectService } from '../project/project.service';
import {
  CHAT_VISIBILITIES,
  isChatKind,
  isChatVisibility,
  CHAT_KINDS,
  ProjectStatus,
  type ChatVisibility,
} from '../project/project.types';
import { findVisibleSkill } from '../store/skill-visibility';
import { BuilderChatRepository, type ChatRow, type TestProjectRow } from './builder-chat.repository';
import {
  BUILDER_CHAT_FILTERS,
  type BuilderChatCaller,
  type BuilderChatCreated,
  type BuilderChatFilter,
  type BuilderChatSummary,
  type BuilderSeed,
  type CreateBuilderChatDto,
  type ProducedArtifact,
} from './builder.types';

const DEFAULT_TITLES = {
  skill_builder_chat: 'New Skill',
  agent_builder_chat: 'New Agent',
} as const;

function isSkillSeed(seed: BuilderSeed): seed is { skillId: string } {
  return 'skillId' in seed && typeof seed.skillId === 'string';
}

function isAgentSeed(seed: BuilderSeed): seed is { agentId: string } {
  return 'agentId' in seed && typeof seed.agentId === 'string';
}

@Injectable()
export class BuilderChatService {
  constructor(
    private readonly repository: BuilderChatRepository,
    private readonly projects: ProjectService,
    private readonly agents: AgentService
  ) {}

  async create(caller: BuilderChatCaller, dto: CreateBuilderChatDto): Promise<BuilderChatCreated> {
    if (!isChatKind(dto.kind)) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `kind must be one of ${CHAT_KINDS.join(', ')}`,
      });
    }

    const agentId = await this.agents.findBuilderAgentId();
    if (!agentId) {
      throw new ServiceUnavailableException('The Skill & Agent Builder is not installed on this deployment');
    }

    const seedPrompt = dto.seed === undefined ? null : await this.renderSeed(caller, dto.seed);

    const project = await this.projects.create(
      { title: dto.title?.trim() || DEFAULT_TITLES[dto.kind], agentId },
      caller.tenantId,
      { createdBy: caller.userId, kind: dto.kind }
    );

    return { ...(await this.summarizeOne(caller, project.id)), seedPrompt };
  }

  async list(caller: BuilderChatCaller, filter: BuilderChatFilter = 'active'): Promise<BuilderChatSummary[]> {
    if (!BUILDER_CHAT_FILTERS.includes(filter)) {
      throw new BadRequestException({ code: 'validation_failed', message: `Unknown filter "${filter}"` });
    }

    const rows = await this.repository.listChats(caller.tenantId);
    const matching = rows.filter((row) => {
      if (filter === 'archived') return row.disabled;
      if (filter === 'mine') return !row.disabled && row.createdBy === caller.userId;
      return !row.disabled;
    });

    return this.summarize(caller, matching);
  }

  async open(caller: BuilderChatCaller, chatId: string): Promise<BuilderChatSummary> {
    const chat = await this.requireChat(caller, chatId);
    if (!canOpen(caller, chat)) throw new NotFoundException(`Builder chat ${chatId} not found`);
    return this.summarizeOne(caller, chatId);
  }

  /** Creator-only, and reversible where a Skill's widening is not (ADR-0065). */
  async setVisibility(
    caller: BuilderChatCaller,
    chatId: string,
    visibility: ChatVisibility
  ): Promise<BuilderChatSummary> {
    if (!isChatVisibility(visibility)) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: `visibility must be one of ${CHAT_VISIBILITIES.join(', ')}`,
      });
    }

    const chat = await this.requireChat(caller, chatId);
    if (!isCreator(caller, chat)) {
      throw new ForbiddenException('Only the member who started this chat may change who can open it');
    }

    if (chat.visibility !== visibility) await this.repository.setVisibility(chatId, visibility);
    return this.summarizeOne(caller, chatId);
  }

  /** The list is Organization property, so any holder may archive; only the creator can read it. */
  async archive(caller: BuilderChatCaller, chatId: string): Promise<BuilderChatSummary> {
    const chat = await this.requireChat(caller, chatId);
    if (!chat.disabled) await this.projects.disable(chatId, caller.tenantId);
    return this.summarizeOne(caller, chatId);
  }

  async restore(caller: BuilderChatCaller, chatId: string): Promise<BuilderChatSummary> {
    const chat = await this.requireChat(caller, chatId);
    if (chat.disabled) await this.projects.enable(chatId, caller.tenantId);
    return this.summarizeOne(caller, chatId);
  }

  async remove(caller: BuilderChatCaller, chatId: string): Promise<void> {
    await this.requireChat(caller, chatId);
    await this.deleteTestProjectsOf(caller.tenantId, chatId);
    await this.projects.remove(chatId, caller.tenantId);
  }

  async removeTestProject(caller: BuilderChatCaller, chatId: string): Promise<void> {
    const chat = await this.requireChat(caller, chatId);
    if (!canOpen(caller, chat)) {
      throw new ForbiddenException('Only a member who can open this chat may delete its test project');
    }
    await this.deleteTestProjectsOf(caller.tenantId, chatId);
  }

  /** ADR-0063's one-live-per-chat rule, applied by the public API before the successor is made. */
  async deleteTestProjectsOf(tenantId: string, chatId: string): Promise<void> {
    const existing = await this.repository.testProjectsOf([chatId]);
    for (const row of existing) {
      await this.projects.remove(row.id, tenantId);
    }
  }

  async findChatRow(tenantId: string, chatId: string): Promise<ChatRow | null> {
    return this.repository.findChat(tenantId, chatId);
  }

  private async summarizeOne(caller: BuilderChatCaller, chatId: string): Promise<BuilderChatSummary> {
    const [summary] = await this.summarize(caller, [await this.requireChat(caller, chatId)]);
    return summary;
  }

  private async requireChat(caller: BuilderChatCaller, chatId: string): Promise<ChatRow> {
    const chat = await this.repository.findChat(caller.tenantId, chatId);
    if (!chat) throw new NotFoundException(`Builder chat ${chatId} not found`);
    return chat;
  }

  private async summarize(caller: BuilderChatCaller, rows: ChatRow[]): Promise<BuilderChatSummary[]> {
    const ids = rows.map((row) => row.id);
    const [testProjects, produced] = await Promise.all([
      this.repository.testProjectsOf(ids),
      this.repository.producedBy(ids),
    ]);
    const liveTest = new Map<string, TestProjectRow>();
    for (const row of testProjects) {
      if (row.chatId && !liveTest.has(row.chatId)) liveTest.set(row.chatId, row);
    }

    return rows.map((row) => this.toSummary(caller, row, liveTest.get(row.id), produced.get(row.id) ?? []));
  }

  private toSummary(
    caller: BuilderChatCaller,
    row: ChatRow,
    test: TestProjectRow | undefined,
    produced: ProducedArtifact[]
  ): BuilderChatSummary {
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      visibility: row.visibility,
      createdBy:
        row.createdBy === null ? null : { id: row.createdBy, displayName: row.creatorDisplayName ?? row.createdBy },
      createdAt: row.createdAt,
      lastPromptAt: row.lastPromptAt,
      disabled: row.disabled,
      canOpen: canOpen(caller, row),
      canShare: isCreator(caller, row),
      ...(test === undefined ? {} : { testProject: { id: test.id, environmentStatus: statusOf(test) } }),
      produced,
    };
  }

  private async renderSeed(caller: BuilderChatCaller, seed: BuilderSeed): Promise<string> {
    if (isSkillSeed(seed)) {
      const skill = await findVisibleSkill(caller.tenantId, caller.userId, seed.skillId);
      if (!skill) throw new NotFoundException(`Skill ${seed.skillId} not found`);
      return `Let's work on the Skill \`${skill.name}\` (id ${skill.id}). Read it first, then ask me what to change.`;
    }
    if (isAgentSeed(seed)) {
      const agent = await findVisibleAgent(caller.tenantId, caller.userId, seed.agentId);
      if (!agent) throw new NotFoundException(`Agent ${seed.agentId} not found`);
      const name = agent.displayName ?? agent.name;
      return `Let's work on the Agent \`${name}\` (id ${agent.id}). Read its Development profile first, then ask me what to change.`;
    }
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'A seed names either a skillId or an agentId',
    });
  }
}

function isCreator(caller: BuilderChatCaller, chat: ChatRow): boolean {
  return chat.createdBy === caller.userId;
}

function canOpen(caller: BuilderChatCaller, chat: ChatRow): boolean {
  return isCreator(caller, chat) || chat.visibility === 'public';
}

function statusOf(row: TestProjectRow): ProjectStatus {
  return row.disabled ? ProjectStatus.Disabled : row.status;
}

import { Injectable } from '@nestjs/common';
import { AgentService } from '../../agent/agent.service';
import type { AgentCaller } from '../../agent/agent.types';
import { CreatedAgentsCapReached, type CreatedAgentsCap } from '../../agent/created-agents-cap';
import { MAX_CREATED_AGENTS, PublicApiSettings } from '../../external-services/configuration/public-api-settings';
import { assertPermission, callingEnvironmentOf, callingProjectOf, chatProjectIdOf, type Caller } from '../auth/caller';
import { Errors } from '../errors/public-api-error';
import { mappingStoreErrors } from '../errors/store-error.mapper';
import { AgentMapper } from './agents.mapper';
import { PublicAgentsRepository } from './agents.repository';
import type {
  AgentDetailDto,
  AgentListQuery,
  AgentPageDto,
  AgentSkillListDto,
  CreateAgent,
  SetAgentSkill,
  TemplateSaveDto,
  UpdateAgent,
  UpdateAgentProfile,
} from './agents.schema';

@Injectable()
export class PublicAgentsService {
  constructor(
    private readonly repository: PublicAgentsRepository,
    private readonly agents: AgentService,
    private readonly publicApiSettings: PublicApiSettings
  ) {}

  async list(caller: Caller, query: AgentListQuery): Promise<AgentPageDto> {
    const scope = { tenantId: caller.tenant.id, userId: caller.user.platformId };
    const { rows, nextCursor } = await this.repository.page(scope, query);
    return { items: rows.map(AgentMapper.toDto), nextCursor };
  }

  async findOne(caller: Caller, agentId: string): Promise<AgentDetailDto> {
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.findOne(scopeOf(caller), agentId)));
  }

  async listSkills(caller: Caller, agentId: string): Promise<AgentSkillListDto> {
    const skills = await mappingStoreErrors(() => this.agents.listSkills(scopeOf(caller), agentId));
    return { items: skills.map(AgentMapper.toSkillDto) };
  }

  async create(caller: Caller, body: CreateAgent): Promise<AgentDetailDto> {
    assertPermission(caller, 'can_manage_agents');
    const cap = await this.createdAgentsCapOf(caller);
    const created = await mappingStoreErrors(() =>
      this.agents.create(scopeOf(caller), body, cap).catch((error: unknown) => {
        if (error instanceof CreatedAgentsCapReached) {
          throw Errors.maxCreatedAgents(error.max, this.publicApiSettings.labelOf(MAX_CREATED_AGENTS));
        }
        throw error;
      })
    );
    return AgentMapper.toDetailDto(created);
  }

  private async createdAgentsCapOf(caller: Caller): Promise<CreatedAgentsCap | null> {
    const calling = callingEnvironmentOf(caller);
    if (!calling) return null;
    const settings = await this.publicApiSettings.of(calling.projectEnvironmentId);
    return { creatingProjectId: calling.projectId, max: this.publicApiSettings.limitOf(settings, MAX_CREATED_AGENTS) };
  }

  async update(caller: Caller, agentId: string, body: UpdateAgent): Promise<AgentDetailDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.update(scope, agentId, body)));
  }

  async updateProfile(caller: Caller, agentId: string, body: UpdateAgentProfile): Promise<AgentDetailDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.updateProfile(scope, agentId, body)));
  }

  async saveTemplate(caller: Caller, agentId: string): Promise<TemplateSaveDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    return mappingStoreErrors(() => this.agents.saveTemplate(scope, agentId, chatProjectIdOf(caller)));
  }

  async setSkill(caller: Caller, agentId: string, skillId: string, body: SetAgentSkill): Promise<AgentSkillListDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    const skills = await mappingStoreErrors(() => this.agents.setSkill(scope, agentId, skillId, body));
    return { items: skills.map(AgentMapper.toSkillDto) };
  }

  async removeSkill(caller: Caller, agentId: string, skillId: string): Promise<AgentSkillListDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    const skills = await mappingStoreErrors(() => this.agents.removeSkill(scope, agentId, skillId));
    return { items: skills.map(AgentMapper.toSkillDto) };
  }

  private async scopeAfterVisibleRead(caller: Caller, agentId: string): Promise<AgentCaller> {
    const scope = scopeOf(caller);
    await mappingStoreErrors(() => this.agents.findOne(scope, agentId));
    assertPermission(caller, 'can_manage_agents');
    return scope;
  }
}

function scopeOf(caller: Caller): AgentCaller {
  return {
    tenantId: caller.tenant.id,
    userId: caller.user.platformId,
    canManageAgents: caller.permissions.has('can_manage_agents'),
    ...callingProjectOf(caller),
  };
}

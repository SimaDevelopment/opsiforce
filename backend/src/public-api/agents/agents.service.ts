import { Injectable } from '@nestjs/common';
import { AgentService } from '../../agent/agent.service';
import type { AgentCaller } from '../../agent/agent.types';
import { Perms } from '../../permission/permission.constants';
import { assertPermission, chatProjectIdOf, type Caller } from '../auth/caller';
import { mappingStoreErrors } from '../errors/store-error.mapper';
import { AgentMapper } from './agents.mapper';
import { PublicAgentsRepository } from './agents.repository';
import type {
  AgentDetailDto,
  AgentListQuery,
  AgentPageDto,
  AgentSkillListDto,
  CreateAgent,
  DuplicateAgent,
  SetAgentSkill,
  UpdateAgentProfile,
} from './agents.schema';

@Injectable()
export class PublicAgentsService {
  constructor(
    private readonly repository: PublicAgentsRepository,
    private readonly agents: AgentService
  ) {}

  async list(caller: Caller, query: AgentListQuery): Promise<AgentPageDto> {
    const scope = { tenantId: caller.organization.id, userId: caller.user.platformId };
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
    assertPermission(caller, Perms.manageAgents);
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.create(scopeOf(caller), body)));
  }

  async updateProfile(caller: Caller, agentId: string, body: UpdateAgentProfile): Promise<AgentDetailDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.updateProfile(scope, agentId, body)));
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

  async duplicate(caller: Caller, agentId: string, body: DuplicateAgent): Promise<AgentDetailDto> {
    const scope = await this.scopeAfterVisibleRead(caller, agentId);
    return AgentMapper.toDetailDto(await mappingStoreErrors(() => this.agents.duplicate(scope, agentId, body)));
  }

  private async scopeAfterVisibleRead(caller: Caller, agentId: string): Promise<AgentCaller> {
    const scope = scopeOf(caller);
    await mappingStoreErrors(() => this.agents.findOne(scope, agentId));
    assertPermission(caller, Perms.manageAgents);
    return scope;
  }
}

function scopeOf(caller: Caller): AgentCaller {
  return {
    tenantId: caller.organization.id,
    userId: caller.user.platformId,
    canManageAgents: caller.permissions.has(Perms.manageAgents),
    createdInChatProjectId: chatProjectIdOf(caller),
  };
}

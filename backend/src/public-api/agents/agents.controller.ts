import { Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../public-api.decorator';
import { AgentMapper } from './agents.mapper';
import { PublicAgentsRepository } from './agents.repository';
import { AgentListQuerySchema, AgentPageSchema, type AgentListQuery, type AgentPageDto } from './agents.schema';

@ApiTags('Agents')
@PublicApiController('agents')
export class AgentsController {
  constructor(private readonly agents: PublicAgentsRepository) {}

  @Get()
  @ApiOperation({
    summary: 'List Agents',
    description:
      'The Agents you can build a Project on. Pass an id from here as agentId when creating one. Newest first; page with the opaque cursor.\n\n**Use it for** filling an Agent picker before Create a Project, or turning a name a user typed ("app-builder") into the agentId the create route wants. Agent ids differ per deployment, so resolve them here rather than storing one in your config.',
  })
  @PublicResponse(200, AgentPageSchema)
  @PublicApiErrors('validation-error')
  async list(@Query({ schema: AgentListQuerySchema }) query: AgentListQuery): Promise<AgentPageDto> {
    const { rows, nextCursor } = await this.agents.page(query);
    return { items: rows.map(AgentMapper.toDto), nextCursor };
  }
}

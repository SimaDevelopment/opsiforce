import { Body, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowsGatewayCaller } from '../auth/allows-gateway-caller.decorator';
import { Caller } from '../auth/caller';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../public-api.decorator';
import { PublicAgentsService } from './agents.service';
import {
  AgentDetailSchema,
  AgentListQuerySchema,
  AgentPageSchema,
  AgentPathSchema,
  AgentSkillListSchema,
  AgentSkillPathSchema,
  CreateAgentSchema,
  SetAgentSkillSchema,
  UpdateAgentProfileSchema,
  UpdateAgentSchema,
  type AgentDetailDto,
  type AgentListQuery,
  type AgentPageDto,
  type AgentPath,
  type AgentSkillListDto,
  type AgentSkillPath,
  type CreateAgent,
  type SetAgentSkill,
  type UpdateAgent,
  type UpdateAgentProfile,
} from './agents.schema';

@ApiTags('Agents')
@PublicApiController('agents')
export class AgentsController {
  constructor(private readonly agents: PublicAgentsService) {}

  @Get()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'List Agents',
    description:
      'The Agents you can build a Project on. Pass an id from here as agentId when creating one. Newest first; page with the opaque cursor.\n\n**Use it for** filling an Agent picker before Create a Project, or turning a name a user typed ("app-builder") into the agentId the create route wants. Agent ids differ per deployment, so resolve them here rather than storing one in your config.',
  })
  @PublicResponse(200, AgentPageSchema)
  @PublicApiErrors('validation-error')
  list(
    @Caller() caller: Caller,
    @Query({ schema: AgentListQuerySchema }) query: AgentListQuery
  ): Promise<AgentPageDto> {
    return this.agents.list(caller, query);
  }

  @Post()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Create a Custom Agent',
    description:
      "Creates an Agent private to you, with a kebab-case slug derived from `displayName` and a Development profile carrying an empty prompt, the given or default model pair, and the built-in `platform` Skill. The slug cannot change afterwards; a slug the deployment already uses is refused with 409.\n\nThe model must exist in the running distribution's catalog, and `variant` must be one of that model's reasoning efforts, or the call is refused naming the part that failed.\n\n**Use it for** standing an Agent up before writing it: create, then `PUT /agents/{id}/profile` with the prompt, then add Skills. A Project can be created from it as soon as its Development profile exists.",
  })
  @PublicResponse(201, AgentDetailSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'name-unavailable', 'model-unknown', 'bad-request')
  create(@Caller() caller: Caller, @Body({ schema: CreateAgentSchema }) body: CreateAgent): Promise<AgentDetailDto> {
    return this.agents.create(caller, body);
  }

  @Get(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Get an Agent',
    description:
      'One Agent with its settings and one entry per Environment of the Organization. Every entry carries `environmentId`; `skills: null` marks an Environment this Agent has no profile at, which is how you tell "never published there" from "published with no Skills".\n\nA Built-in Agent reports `imageOwned: true` with `promptBody`, `model` and `variant` null — its behaviour comes from the agent image — but its Skills are the Organization\'s and are listed.\n\n**Use it for** reading the Development profile before editing it, and for `updateAvailable` on each pinned Skill.',
  })
  @PublicResponse(200, AgentDetailSchema)
  @PublicApiErrors('not-found')
  get(@Caller() caller: Caller, @Param({ schema: AgentPathSchema }) path: AgentPath): Promise<AgentDetailDto> {
    return this.agents.findOne(caller, path.id);
  }

  @Patch(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Rename or describe an Agent',
    description:
      "Sets a Custom Agent's display name, or the one line the Store and the Project picker show under it. The slug stays what it was at creation, so Projects and links keep working.\n\n**Use it for** settling the description once the brief is clear, and renaming when the author asks for another name.",
  })
  @PublicResponse(200, AgentDetailSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'not-found', 'not-publishable', 'forbidden')
  update(
    @Caller() caller: Caller,
    @Param({ schema: AgentPathSchema }) path: AgentPath,
    @Body({ schema: UpdateAgentSchema }) body: UpdateAgent
  ): Promise<AgentDetailDto> {
    return this.agents.update(caller, path.id, body);
  }

  @Put(':id/profile')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Edit the Development profile',
    description:
      'Overwrites the Development profile: prompt body, model and reasoning effort. There are no Agent versions — this is the working copy, and Projects created from it afterwards get it. Existing Projects keep the files they were created with.\n\nRefused for a Built-in Agent, which the agent image owns, and for a model or variant this deployment does not carry.\n\n**Use it for** the write half of the authoring loop. Read the Agent, change `promptBody`, send the whole profile back.',
  })
  @PublicResponse(200, AgentDetailSchema)
  @PublicApiErrors(
    'validation-error',
    'permission-denied',
    'not-found',
    'model-unknown',
    'not-publishable',
    'forbidden'
  )
  updateProfile(
    @Caller() caller: Caller,
    @Param({ schema: AgentPathSchema }) path: AgentPath,
    @Body({ schema: UpdateAgentProfileSchema }) body: UpdateAgentProfile
  ): Promise<AgentDetailDto> {
    return this.agents.updateProfile(caller, path.id, body);
  }

  @Get(':id/skills')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: "List an Agent's Skills",
    description:
      "The Skills the Agent's Development profile carries, each with the Version it pins and whether a newer one exists.\n\n**Use it for** checking what an Agent already has before adding to it, and for spotting upgrades without fetching the whole Agent.",
  })
  @PublicResponse(200, AgentSkillListSchema)
  @PublicApiErrors('not-found')
  skills(@Caller() caller: Caller, @Param({ schema: AgentPathSchema }) path: AgentPath): Promise<AgentSkillListDto> {
    return this.agents.listSkills(caller, path.id);
  }

  @Put(':id/skills/:skillId')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Add or re-pin a Skill',
    description:
      'Puts the Skill on the Development profile, pinned to `versionId` or, with an empty object, to the latest Version. Sending it again with a newer `versionId` is the upgrade.\n\nRefused when the Skill is disabled, when the Agent already carries a different Skill of the same name — opencode would resolve the collision silently — and when a private Skill would land on a public or Built-in Agent.\n\n**Use it for** both adding and upgrading; there is no separate upgrade route. The answer is the whole Skill set, so you never have to re-read it.',
  })
  @PublicResponse(200, AgentSkillListSchema)
  @PublicApiErrors(
    'validation-error',
    'permission-denied',
    'not-found',
    'visibility-incoherent',
    'duplicate-skill-name',
    'forbidden'
  )
  setSkill(
    @Caller() caller: Caller,
    @Param({ schema: AgentSkillPathSchema }) path: AgentSkillPath,
    @Body({ schema: SetAgentSkillSchema }) body: SetAgentSkill
  ): Promise<AgentSkillListDto> {
    return this.agents.setSkill(caller, path.id, path.skillId, body);
  }

  @Delete(':id/skills/:skillId')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Remove a Skill',
    description:
      "Takes the Skill off the Development profile. The Skill itself is untouched, and Projects already created keep their copy. The built-in `platform` Skill cannot be removed — every Agent inherits the platform's own harness through it.\n\n**Use it for** trimming an Agent you are authoring. The answer is the remaining Skill set.",
  })
  @PublicResponse(200, AgentSkillListSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'not-found', 'forbidden')
  removeSkill(
    @Caller() caller: Caller,
    @Param({ schema: AgentSkillPathSchema }) path: AgentSkillPath
  ): Promise<AgentSkillListDto> {
    return this.agents.removeSkill(caller, path.id, path.skillId);
  }
}

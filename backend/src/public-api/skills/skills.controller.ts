import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowsGatewayCaller } from '../auth/allows-gateway-caller.decorator';
import { Caller } from '../auth/caller';
import { PublicApiController, PublicApiErrors, PublicResponse } from '../public-api.decorator';
import { PublicSkillsService } from './skills.service';
import {
  CreateSkillSchema,
  CreateSkillVersionSchema,
  DuplicateSkillSchema,
  SkillFileListSchema,
  SkillListQuerySchema,
  SkillListSchema,
  SkillPathSchema,
  SkillSchema,
  SkillValidationSchema,
  SkillVersionPathSchema,
  UpdateSkillSchema,
  ValidateSkillSchema,
  type CreateSkill,
  type CreateSkillVersion,
  type DuplicateSkill,
  type SkillDto,
  type SkillFileListDto,
  type SkillListQuery,
  type SkillListDto,
  type SkillPath,
  type SkillValidationDto,
  type SkillVersionPath,
  type UpdateSkill,
  type ValidateSkill,
} from './skills.schema';

@ApiTags('Skills')
@PublicApiController('skills')
export class SkillsController {
  constructor(private readonly skills: PublicSkillsService) {}

  @Get()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'List Skills',
    description:
      'Every Skill you can see: the Built-in ones the agent image ships, the public ones of your tenant, and your own private ones. Filter with `filter` and search with `q`; `filter=disabled` needs `can_manage_skills`.\n\n**Use it for** finding a Skill to put on an Agent, or checking whether a name is taken before authoring one. The answer is the whole set — a tenant holds tens of Skills, not thousands, so this list does not paginate.',
  })
  @PublicResponse(200, SkillListSchema)
  @PublicApiErrors('validation-error', 'permission-denied')
  list(
    @Caller() caller: Caller,
    @Query({ schema: SkillListQuerySchema }) query: SkillListQuery
  ): Promise<SkillListDto> {
    return this.skills.list(caller, query);
  }

  @Post()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Create a Skill',
    description:
      'Submits a whole file tree and, if it passes the validation gate, creates the Skill private to you at Version 1. There is no draft: saving is publishing. A tree that fails answers 422 with every error and lint, each carrying its rule, file and line, so a failed submission is a work list rather than a dead end.\n\nThe `name` must be kebab-case, at most 64 characters, and equal to the `name` in `SKILL.md`. Names the agent image already ships are refused with 409.\n\n**Use it for** turning an authored package into a Skill an Agent can carry. Run `POST /skills/validate` first when you want the findings without creating anything.',
  })
  @PublicResponse(201, SkillSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'name-unavailable', 'validation-failed')
  create(@Caller() caller: Caller, @Body({ schema: CreateSkillSchema }) body: CreateSkill): Promise<SkillDto> {
    return this.skills.create(caller, body);
  }

  @Post('validate')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Validate a Skill tree',
    description:
      'Runs the same gate a create or a new Version runs, and writes nothing. Answers 200 whether or not the tree passes: read `valid`, then `errors` and `lints`.\n\n**Use it for** the edit loop — validate until `valid` is true, then create the Skill or the Version in one call that you know will be accepted.',
  })
  @PublicResponse(200, SkillValidationSchema)
  @PublicApiErrors('validation-error', 'permission-denied')
  validate(@Caller() caller: Caller, @Body({ schema: ValidateSkillSchema }) body: ValidateSkill): SkillValidationDto {
    return this.skills.validate(caller, body);
  }

  @Get(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Get a Skill',
    description:
      "One Skill by id, with its latest Version, its flags and how many Agents carry it. A Skill you cannot see answers 404.\n\n**Use it for** reading `latestVersion.version` before pinning it on an Agent, and for `flags` — `hasExecutables` is what a reviewer wants to see before handing a Skill to a tenant's Agents.",
  })
  @PublicResponse(200, SkillSchema)
  @PublicApiErrors('not-found')
  get(@Caller() caller: Caller, @Param({ schema: SkillPathSchema }) path: SkillPath): Promise<SkillDto> {
    return this.skills.findOne(caller, path.id);
  }

  @Patch(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Rename a Skill',
    description:
      "Sets the display name the Store and the Agent pages show. The `name` — the Skill's identity and its frontmatter `name` — stays what it was at creation.\n\n**Use it for** renaming when the author asks for another name.",
  })
  @PublicResponse(200, SkillSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'not-found', 'forbidden')
  update(
    @Caller() caller: Caller,
    @Param({ schema: SkillPathSchema }) path: SkillPath,
    @Body({ schema: UpdateSkillSchema }) body: UpdateSkill
  ): Promise<SkillDto> {
    return this.skills.update(caller, path.id, body);
  }

  @Get(':id/versions/:version/files')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Read the files of a Version',
    description:
      'Every file of one Version, `SKILL.md` first as it is stored. Text arrives as UTF-8 in `content`; a binary file arrives base64 with `isBinary` true.\n\n**Use it for** reading a Skill before duplicating or extending it: fetch the files, edit them, then submit the whole tree back as a new Version or as a Duplicate.',
  })
  @PublicResponse(200, SkillFileListSchema)
  @PublicApiErrors('validation-error', 'not-found')
  files(
    @Caller() caller: Caller,
    @Param({ schema: SkillVersionPathSchema }) path: SkillVersionPath
  ): Promise<SkillFileListDto> {
    return this.skills.listFiles(caller, path.id, path.version);
  }

  @Post(':id/versions')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Publish a new Version',
    description:
      'Submits the whole tree again and mints the next integer Version, moving the Skill\'s latest pointer. Agents keep the Version they pinned and start showing "update available"; nothing upgrades on its own.\n\n**Use it for** shipping a fix to a Skill you own. The frontmatter `name` must still match the Skill; a copy under a new name is a Duplicate.',
  })
  @PublicResponse(201, SkillSchema)
  @PublicApiErrors(
    'validation-error',
    'permission-denied',
    'not-found',
    'validation-failed',
    'forbidden',
    'bad-request'
  )
  addVersion(
    @Caller() caller: Caller,
    @Param({ schema: SkillPathSchema }) path: SkillPath,
    @Body({ schema: CreateSkillVersionSchema }) body: CreateSkillVersion
  ): Promise<SkillDto> {
    return this.skills.addVersion(caller, path.id, body);
  }

  @Post(':id/duplicate')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Duplicate a Skill',
    description:
      "Copies the source's latest Version into a new private Skill of your own under a new name, rewriting the frontmatter `name` to match. Nothing about the source is recorded, and the copy never follows it.\n\n**Use it for** varying a Built-in or a colleague's Skill you may not edit: duplicate it, then publish Versions on the copy.",
  })
  @PublicResponse(201, SkillSchema)
  @PublicApiErrors('validation-error', 'permission-denied', 'not-found', 'name-unavailable', 'validation-failed')
  duplicate(
    @Caller() caller: Caller,
    @Param({ schema: SkillPathSchema }) path: SkillPath,
    @Body({ schema: DuplicateSkillSchema }) body: DuplicateSkill
  ): Promise<SkillDto> {
    return this.skills.duplicate(caller, path.id, body);
  }
}

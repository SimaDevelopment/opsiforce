import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Perms } from '../permission/permission.constants';
import { RelaxPermission, RequirePermission } from '../permission/permission.guard';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { MAX_TREE_BYTES } from './gate';
import { SkillService, type SkillCaller } from './skill.service';
import type {
  CreateSkillDto,
  CreateSkillVersionDto,
  DuplicateSkillDto,
  GateResponse,
  SetSkillVisibilityDto,
  SkillAgentUsage,
  SkillFileResponse,
  SkillSummary,
  SkillVersionResponse,
  UpdateSkillDto,
  ValidateSkillDto,
} from './skill.types';

interface MultipartRequest extends FastifyRequest {
  parts(): AsyncIterableIterator<MultipartFile | { type: 'field' }>;
}

@Controller('skills')
@RequirePermission(Perms.manageSkills)
export class SkillsController {
  constructor(
    private readonly skillService: SkillService,
    private readonly userService: UserService
  ) {}

  @Get()
  @RelaxPermission()
  async list(
    @Query('filter') filter: string | undefined,
    @Query('q') query: string | undefined,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary[]> {
    return this.skillService.list(await this.caller(req, tenant, user), filter, query);
  }

  @Get(':id')
  @RelaxPermission()
  async findOne(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.findOne(await this.caller(req, tenant, user), id);
  }

  @Get(':id/agents')
  @RelaxPermission()
  async listAgents(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillAgentUsage[]> {
    return this.skillService.listAgents(await this.caller(req, tenant, user), id);
  }

  @Get(':id/versions')
  @RelaxPermission()
  async listVersions(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillVersionResponse[]> {
    return this.skillService.listVersions(await this.caller(req, tenant, user), id);
  }

  @Get(':id/versions/:version/files')
  @RelaxPermission()
  async listFiles(
    @Param('id') id: string,
    @Param('version') version: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillFileResponse[]> {
    return this.skillService.listFiles(await this.caller(req, tenant, user), id, Number(version));
  }

  @Get(':id/versions/:version/export')
  @RelaxPermission()
  async export(
    @Param('id') id: string,
    @Param('version') version: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    const caller = await this.caller(req, tenant, user);
    const exported = await this.skillService.exportVersion(caller, id, Number(version));

    await reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', exported.archive.byteLength)
      .header('Content-Disposition', contentDisposition(exported.fileName))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(exported.archive);
  }

  @Post()
  async create(
    @Body() dto: CreateSkillDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.create(await this.caller(req, tenant, user), dto);
  }

  @Post('validate')
  @HttpCode(200)
  validate(@Body() dto: ValidateSkillDto): GateResponse {
    return this.skillService.validate(dto);
  }

  @Post('import')
  async import(
    @Req() req: MultipartRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    const caller = await this.caller(req, tenant, user);
    return this.skillService.import(caller, await readArchive(req));
  }

  @Post(':id/versions')
  async addVersion(
    @Param('id') id: string,
    @Body() dto: CreateSkillVersionDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.addVersion(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Body() dto: DuplicateSkillDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.duplicate(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/visibility')
  async setVisibility(
    @Param('id') id: string,
    @Body() dto: SetSkillVisibilityDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.setVisibility(await this.caller(req, tenant, user), id, dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.update(await this.caller(req, tenant, user), id, dto);
  }

  @Post(':id/archive')
  async archive(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.setArchived(await this.caller(req, tenant, user), id, true);
  }

  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<SkillSummary> {
    return this.skillService.setArchived(await this.caller(req, tenant, user), id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<void> {
    await this.skillService.remove(await this.caller(req, tenant, user), id);
  }

  private async caller(req: FastifyRequest, tenant: TenantContext, user: UserContext): Promise<SkillCaller> {
    return {
      tenantId: tenant.tenantId,
      userId: await this.userService.resolveUserId(user, tenant.tenantId),
      canManageSkills: hasPermission(getGroupsHeader(req), Perms.manageSkills),
    };
  }
}

async function readArchive(req: MultipartRequest): Promise<Buffer> {
  for await (const part of req.parts()) {
    if (part.type !== 'file') continue;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += (chunk as Buffer).length;
      if (size > MAX_TREE_BYTES) {
        throw new BadRequestException({
          code: 'bad_request',
          message: `The archive is larger than the ${MAX_TREE_BYTES} byte limit`,
        });
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
  throw new BadRequestException({ code: 'bad_request', message: 'No archive was uploaded' });
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

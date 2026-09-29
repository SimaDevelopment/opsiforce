import { BadRequestException, Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { rm } from 'node:fs/promises';
import { ProjectImportService } from './project-import.service';
import { ProjectImportUploadService } from './project-import-upload.service';
import { ProjectImportStatus, type FinalizeImportDto, type ProjectImportJobResponse } from './project-import.types';
import { ProjectService } from './project.service';
import { ProjectEventsService } from './project-events.service';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { RequirePermission } from '../permission/permission.guard';
import { Perms } from '../permission/permission.constants';
import { getGroupsHeader, hasPermission } from '../permission/permission.utils';

@Controller('projects')
export class ProjectImportController {
  constructor(
    private readonly importService: ProjectImportService,
    private readonly uploadService: ProjectImportUploadService,
    private readonly projectService: ProjectService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly userService: UserService
  ) {}

  @Post('import')
  @RequirePermission(Perms.importProject)
  async start(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Body() dto: FinalizeImportDto | undefined,
    @Req() req: FastifyRequest
  ) {
    const uploadId = dto?.uploadId?.trim();
    if (!uploadId) throw new BadRequestException('An "uploadId" from a chunked upload session is required');

    const session = { tenantId: tenant.tenantId, uploadId };
    const filePath = this.importService.newUploadPath();
    try {
      return await this.uploadService.consumeUpload(session, filePath, async () => {
        const userId = await this.userService.resolveUserId(user, tenant.tenantId);
        const canManageWorkspaces = hasPermission(getGroupsHeader(req), Perms.manageWorkspaces);
        return this.importService.startImport({
          tenantId: tenant.tenantId,
          workspaceId: dto?.workspaceId?.trim() || null,
          folderId: dto?.folderId?.trim() || null,
          userId,
          canManageWorkspaces,
          titleOverride: dto?.title ?? null,
          timezone: dto?.timezone?.trim() || 'UTC',
          uploadPath: filePath,
        });
      });
    } catch (err) {
      await rm(filePath, { force: true }).catch(() => {});
      throw err;
    }
  }

  @Get(':projectId/import/job')
  @RequirePermission(Perms.importProject)
  async latestJob(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.gate(projectId, tenant.tenantId, user);
    return this.importService.getLatestJob(projectId);
  }

  @Get(':projectId/import/job/stream')
  @RequirePermission(Perms.importProject)
  async jobStream(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ) {
    await this.gate(projectId, tenant.tenantId, user);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-no-compression': '1',
    });

    let closed = false;
    let lastSerialized: string | null = null;
    let lastJob: ProjectImportJobResponse | null = null;
    let sentTerminal = false;
    let unsubscribe = () => {};
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': ping\n\n');
    }, 25000);
    const close = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    const send = async () => {
      if (closed) return;
      const job = await this.importService.getLatestJob(projectId);
      if (closed) return;
      if (!job) {
        if (lastJob && !sentTerminal) {
          sentTerminal = true;
          const fallback = { ...lastJob, status: ProjectImportStatus.Failed, error: lastJob.error ?? 'Import failed.' };
          reply.raw.write(`data: ${JSON.stringify(fallback)}\n\n`);
        }
        return;
      }
      lastJob = job;
      if (job.status === ProjectImportStatus.Failed || job.status === ProjectImportStatus.Completed) {
        sentTerminal = true;
      }
      const serialized = JSON.stringify(job);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      reply.raw.write(`data: ${serialized}\n\n`);
    };

    unsubscribe = this.projectEventsService.subscribe(projectId, () => {
      void send();
    });

    req.raw.on('close', close);
    await send();
  }

  private async gate(projectId: string, tenantId: string, user: UserContext): Promise<void> {
    const userId = await this.userService.resolveUserId(user, tenantId);
    await this.projectService.findOneForUser({ projectId, tenantId, userId });
  }
}

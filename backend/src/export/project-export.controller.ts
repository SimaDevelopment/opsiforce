import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { open } from 'node:fs/promises';
import { ProjectExportService } from './project-export.service';
import { ProjectService } from '../project/project.service';
import { ProjectEventsService } from '../project/project-events.service';
import { isChatKind, type ProjectResponse } from '../project/project.types';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { RequirePermission } from '../permission/permission.guard';
import { Perms } from '../permission/permission.constants';

@Controller('projects/:projectId/export')
export class ProjectExportController {
  constructor(
    private readonly exportService: ProjectExportService,
    private readonly projectService: ProjectService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly userService: UserService
  ) {}

  @Post()
  @RequirePermission(Perms.exportProject)
  async start(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    const project = await this.gate(projectId, tenant.tenantId, user);
    if (isChatKind(project.kind)) {
      throw new BadRequestException({
        code: 'not_exportable',
        message: 'A Builder chat belongs to its skill or agent and cannot be exported',
      });
    }
    return this.exportService.startExport(projectId, tenant.tenantId);
  }

  @Get('job')
  @RequirePermission(Perms.exportProject)
  async latestJob(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.gate(projectId, tenant.tenantId, user);
    return this.exportService.getLatestJob(projectId);
  }

  @Get('job/stream')
  @RequirePermission(Perms.exportProject)
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
      const job = await this.exportService.getLatestJob(projectId);
      if (closed || !job) return;
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

  @Get('download')
  @RequirePermission(Perms.exportProject)
  async download(
    @Param('projectId') projectId: string,
    @Query('jobId') jobId: string | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    await this.gate(projectId, tenant.tenantId, user);
    if (!jobId) throw new BadRequestException('Missing export job id');

    const artifact = await this.exportService.findCompletedArtifact(projectId, jobId);
    const handle = await open(artifact.filePath, 'r').catch(() => null);
    if (!handle) throw new NotFoundException('Export file not found');

    const info = await handle.stat().catch(() => null);
    if (!info || !info.isFile()) {
      await handle.close().catch(() => {});
      throw new NotFoundException('Export file not found');
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': info.size,
      'Content-Disposition': contentDisposition(artifact.fileName),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    const stream = handle.createReadStream();
    const abort = () => stream.destroy();
    req.raw.on('close', abort);
    stream.on('error', () => {
      req.raw.off('close', abort);
      reply.raw.destroy();
    });
    stream.on('end', () => req.raw.off('close', abort));
    stream.on('close', () => {
      handle.close().catch(() => {});
    });
    reply.raw.on('finish', () => {
      void this.exportService.purgeJob(jobId);
    });
    stream.pipe(reply.raw);
  }

  private async gate(projectId: string, tenantId: string, user: UserContext): Promise<ProjectResponse> {
    const userId = await this.userService.resolveUserId(user, tenantId);
    return this.projectService.findOneForUser({ projectId, tenantId, userId });
  }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

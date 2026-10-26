import { Body, ConflictException, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PublishService } from './publish.service';
import { PublishDto } from './publish.types';
import { ProjectService } from '../project/project.service';
import { EXTERNAL_SERVICE_CHAT_KIND } from '../project/project.types';
import { ProjectEventsService } from '../project/project-events.service';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { RequirePermission } from '../permission/permission.guard';

@Controller('projects/:projectId/publish')
export class PublishController {
  constructor(
    private readonly publishService: PublishService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly projectService: ProjectService,
    private readonly userService: UserService
  ) {}

  @Get('targets')
  @RequirePermission('can_publish_project')
  async targets(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.gate(projectId, tenant.tenantId, user);
    return this.publishService.listTargets(projectId, tenant.tenantId);
  }

  @Get('form')
  @RequirePermission('can_publish_project')
  async form(
    @Param('projectId') projectId: string,
    @Query('environmentId') environmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.gate(projectId, tenant.tenantId, user);
    return this.publishService.getForm(projectId, tenant.tenantId, environmentId);
  }

  @Post()
  @RequirePermission('can_publish_project')
  async publish(
    @Param('projectId') projectId: string,
    @Body() dto: PublishDto,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    const project = await this.gate(projectId, tenant.tenantId, user);
    if (project.kind === EXTERNAL_SERVICE_CHAT_KIND) {
      throw new ConflictException({
        code: 'publish-from-service-page',
        message:
          'Publish an External Service from its page in Store → External Services, where you review what goes live',
      });
    }
    return this.publishService.publish(projectId, tenant.tenantId, dto);
  }

  @Get('environments/:environmentId/job')
  @RequirePermission('can_publish_project')
  async latestJob(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ) {
    await this.gate(projectId, tenant.tenantId, user);
    return this.publishService.getLatestJob(projectId, environmentId);
  }

  @Get('environments/:environmentId/job/stream')
  @RequirePermission('can_publish_project')
  async jobStream(
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
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
      const job = await this.publishService.getLatestJob(projectId, environmentId);
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

  private async gate(projectId: string, tenantId: string, user: UserContext) {
    const userId = await this.userService.resolveUserId(user, tenantId);
    return this.projectService.findOneForUser({ projectId, tenantId, userId });
  }
}

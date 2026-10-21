import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';
import { UserService } from '../user/user.service';
import { ProjectService } from './project.service';
import { ProjectEventsService } from './project-events.service';
import { AgentStatusService } from './agent-status.service';
import { AgentStatus } from './project.types';

@Controller('agent-status')
export class AgentStatusStreamController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly userService: UserService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly agentStatusService: AgentStatusService
  ) {}

  @Get('events')
  async stream(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ) {
    const dbUser = await this.userService.getOrCreateUser(
      {
        keycloakId: user.userId,
        email: user.email ?? undefined,
        displayName: user.displayName ?? undefined,
      },
      tenant.tenantId
    );
    const visibleIds = await this.projectService.findVisibleProjectIds({
      tenantId: tenant.tenantId,
      userId: dbUser.id,
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-no-compression': '1',
    });

    let closed = false;
    const unsubscribes: Array<() => void> = [];
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': ping\n\n');
    }, 25000);
    const close = () => {
      closed = true;
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };

    const lastSent = new Map<string, AgentStatus>();
    const sendProject = (projectId: string) => {
      const agentStatus = this.agentStatusService.statusOf(projectId);
      if (lastSent.get(projectId) === agentStatus) return;
      lastSent.set(projectId, agentStatus);
      reply.raw.write(`data: ${JSON.stringify({ projectId, agentStatus })}\n\n`);
    };

    const sentWorkingEnvironments = new Map<string, Set<string>>();
    const sendEnvironment = (projectId: string, environmentId: string, agentStatus: AgentStatus) => {
      reply.raw.write(`event: environment\ndata: ${JSON.stringify({ projectId, environmentId, agentStatus })}\n\n`);
    };
    const sendEnvironments = (projectId: string) => {
      const working = this.agentStatusService.workingEnvironmentsOf(projectId);
      const sentWorking = sentWorkingEnvironments.get(projectId) ?? new Set<string>();
      for (const environmentId of working) {
        if (!sentWorking.has(environmentId)) sendEnvironment(projectId, environmentId, AgentStatus.Working);
      }
      for (const environmentId of sentWorking) {
        if (!working.has(environmentId)) sendEnvironment(projectId, environmentId, AgentStatus.Idle);
      }
      sentWorkingEnvironments.set(projectId, working);
    };

    const send = (projectId: string) => {
      if (closed) return;
      sendProject(projectId);
      sendEnvironments(projectId);
    };

    for (const projectId of visibleIds) {
      unsubscribes.push(this.projectEventsService.subscribe(projectId, () => send(projectId)));
    }

    req.raw.on('close', close);
    for (const projectId of visibleIds) {
      send(projectId);
    }
  }
}

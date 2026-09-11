import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { appCanonicalHost } from '../common/app-host';
import { ForwardedIdentityService } from '../identity/forwarded-identity.service';
import { isProjectVisible } from '../project/project-visibility';
import { ProjectService, type EnsureEnvironmentResult, type ProjectActivityKind } from '../project/project.service';
import { RequestLogMode } from '../project/project.types';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { TenantService } from '../tenant/tenant.service';
import { Public } from '../tenant/tenant.decorator';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { ProxyService } from './proxy.service';

type ProxySurface = 'agent' | 'app' | 'vscode' | 'db';

interface ProxySurfaceBody {
  surface?: ProxySurface;
}

interface ProxyLoggingConfig {
  mode: RequestLogMode;
  bodyLimit: number;
}

interface EnsureProxyResponse {
  state: EnsureEnvironmentResult['state'];
  canonicalHost?: string;
  upstream?: string;
  podName?: string | null;
  directory?: string;
  logging?: ProxyLoggingConfig;
}

@Public()
@Controller('internal/proxy')
export class ProxyController {
  private readonly proxyControlToken: string;
  private readonly appsHostname: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly proxyService: ProxyService,
    private readonly projectService: ProjectService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly tenantService: TenantService,
    private readonly agentSessionGateway: AgentSessionGateway,
    private readonly identities: ForwardedIdentityService
  ) {
    this.proxyControlToken = this.configService.getOrThrow<string>('proxyControlToken');
    this.appsHostname = this.configService.getOrThrow<string>('appsHostname');
  }

  @Post('projects/:environmentId/ensure')
  async ensureEnvironment(
    @Param('environmentId') environmentId: string,
    @Body() body: ProxySurfaceBody,
    @Headers('x-proxy-control-token') token: string | undefined,
    @Req() request: FastifyRequest
  ): Promise<EnsureProxyResponse> {
    this.assertToken(token);

    const surface = requireSurface(body);

    const env = await this.projectEnvironmentService.findByIdOrNull(environmentId);
    if (!env) throw new NotFoundException(`Project environment ${environmentId} not found`);

    if (surface === 'agent') {
      if (!env.tenantId) throw new BadRequestException(`Project environment ${environmentId} not yet claimed`);
      await this.assertAgentSurfaceAccess(env.tenantId, env.projectId, request);
    }

    const ensured =
      surface === 'agent'
        ? await this.agentSessionGateway.ensureAgentSurface(env)
        : await this.projectService.ensureEnvironment(env, activityForSurface(surface));

    return this.toEnsureResponse(surface, ensured, env);
  }

  @Post('projects/:environmentId/failure')
  async handleEnvironmentFailure(
    @Param('environmentId') environmentId: string,
    @Headers('x-proxy-control-token') token: string | undefined
  ): Promise<{ restart: boolean }> {
    this.assertToken(token);
    return { restart: await this.projectService.handleProxyFailureByEnvId(environmentId) };
  }

  @Post('projects/:environmentId/activity')
  async touchActivity(
    @Param('environmentId') environmentId: string,
    @Body() body: ProxySurfaceBody,
    @Headers('x-proxy-control-token') token: string | undefined
  ): Promise<void> {
    this.assertToken(token);

    const surface = requireSurface(body);

    await this.projectService.touchEnvironmentActivity(environmentId, activityForSurface(surface));
  }

  @Post('projects/:environmentId/prompt')
  async stampLastPrompt(
    @Param('environmentId') environmentId: string,
    @Headers('x-proxy-control-token') token: string | undefined
  ): Promise<void> {
    this.assertToken(token);
    await this.projectService.stampLastPromptByEnvId(environmentId);
  }

  private toEnsureResponse(
    surface: ProxySurface,
    ensured: EnsureEnvironmentResult,
    resolved: ProjectEnvironmentContext
  ): EnsureProxyResponse {
    const canonical =
      surface === 'app'
        ? { canonicalHost: appCanonicalHost(resolved.id, resolved.environmentSlug, this.appsHostname) }
        : {};

    if (ensured.state !== 'ready') {
      return { state: ensured.state, ...canonical };
    }

    const env = ensured.env;
    const upstream = resolveUpstreamForSurface(this.proxyService, surface, env);

    return {
      state: ensured.state,
      ...canonical,
      upstream,
      podName: this.proxyService.getAssignedPodName(env.id),
      directory: env.directory,
      ...(surface === 'app' ? { logging: { mode: env.requestLogMode, bodyLimit: env.requestLogBodyLimit } } : {}),
    };
  }

  private async assertAgentSurfaceAccess(tenantId: string, projectId: string, request: FastifyRequest): Promise<void> {
    const forwarded = this.identities.read(request);
    if (!forwarded) throw new UnauthorizedException('No forwarded identity');

    const tenantNames = this.tenantService.resolveAccessibleTenantNames(forwarded.groups);
    const tenant = await this.tenantService.getTenantById(tenantId);
    if (!tenant || !tenantNames.includes(tenant.name)) {
      throw new NotFoundException('Project not found');
    }

    const identity = await this.identities.resolve(forwarded, tenantId);
    if (!(await isProjectVisible(tenantId, identity.platformId, projectId))) {
      throw new NotFoundException('Project not found');
    }
  }

  private assertToken(token: string | undefined): void {
    if (!token || token !== this.proxyControlToken) {
      throw new UnauthorizedException('Invalid proxy control token');
    }
  }
}

function resolveUpstreamForSurface(
  proxyService: ProxyService,
  surface: ProxySurface,
  env: ProjectEnvironmentContext
): string {
  switch (surface) {
    case 'agent':
      return proxyService.resolveUpstreamForProject(env);
    case 'app':
      return proxyService.resolveAppUpstreamForProject(env);
    case 'vscode':
      return proxyService.resolveVscodeUpstreamForProject(env);
    case 'db':
      return proxyService.resolveDbUpstreamForProject(env);
  }
}

function requireSurface(body: ProxySurfaceBody): ProxySurface {
  const surface = body.surface;
  if (!surface || !isProxySurface(surface)) {
    throw new BadRequestException('Invalid proxy surface');
  }
  return surface;
}

function activityForSurface(surface: ProxySurface): ProjectActivityKind {
  return surface === 'app' ? 'app' : 'agent';
}

function isProxySurface(value: string): value is ProxySurface {
  return value === 'agent' || value === 'app' || value === 'vscode' || value === 'db';
}

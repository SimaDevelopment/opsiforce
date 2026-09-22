import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { ForwardedIdentityService } from '../identity/forwarded-identity.service';
import { gatewayBearerOf } from '../public-api/auth/gateway-bearer';
import { ProjectProvenanceRepository } from '../project/project-provenance.repository';
import { isHiddenProjectReachable, isProjectAccessible } from '../project/project-visibility';
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
    private readonly identities: ForwardedIdentityService,
    private readonly gatewayKeys: GatewayKeyService,
    private readonly provenance: ProjectProvenanceRepository
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
      await this.assertSurfaceAccess(env.tenantId, env.projectId, request);
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

  private async assertSurfaceAccess(tenantId: string, projectId: string, request: FastifyRequest): Promise<void> {
    const gatewayToken = gatewayBearerOf(request.headers);
    if (gatewayToken) {
      await this.assertGatewayCallerAccess(gatewayToken, tenantId, projectId);
      return;
    }

    const forwarded = this.identities.read(request);
    if (!forwarded) throw new UnauthorizedException('No forwarded identity');

    const tenantNames = this.tenantService.resolveAccessibleTenantNames(forwarded.groups);
    const tenant = await this.tenantService.getTenantById(tenantId);
    if (!tenant || !tenantNames.includes(tenant.name)) {
      throw new NotFoundException('Project not found');
    }

    const identity = await this.identities.resolve(forwarded, tenantId);
    await this.assertKindStampedVisibility(tenantId, projectId, identity.platformId);
    if (!(await isProjectAccessible(tenantId, identity.platformId, projectId))) {
      throw new NotFoundException('Project not found');
    }
  }

  /** The third predicate beside tenant membership and project visibility (ADR-0065). */
  private async assertKindStampedVisibility(tenantId: string, projectId: string, userId: string): Promise<void> {
    if ((await this.provenance.findKind(projectId)) === null) return;
    if (await isHiddenProjectReachable(tenantId, userId, projectId)) return;
    throw new ForbiddenException('This chat is private to the member who started it');
  }

  private async assertGatewayCallerAccess(token: string, tenantId: string, projectId: string): Promise<void> {
    const key = await this.gatewayKeys.validateToken(token, 'platform-api');
    if (!key) throw new UnauthorizedException('Unknown gateway key');
    if (key.tenantId !== tenantId) throw new NotFoundException('Project not found');

    const creatorId = await this.provenance.findCreatorId(key.projectId);
    if (!creatorId) throw new UnauthorizedException('The calling Project has no creator');

    const creator = await this.identities.resolveByPlatformId(creatorId);
    const tenant = await this.tenantService.getTenantById(tenantId);
    if (!creator || !tenant || !this.tenantService.resolveAccessibleTenantNames(creator.groups).includes(tenant.name)) {
      throw new NotFoundException('Project not found');
    }

    if (!(await isProjectAccessible(tenantId, creatorId, projectId))) {
      throw new NotFoundException('Project not found');
    }

    if (!(await this.provenance.isCreatedByProject(projectId, key.projectId))) {
      throw new ForbiddenException('The calling Project did not create this Project');
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

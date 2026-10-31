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
import { legacyAppHost } from '../common/app-host';
import { WHO_CHANGES_PUBLIC_API_SETTINGS } from '../external-services/built-ins/public-api-service';
import { PublicApiSettings } from '../external-services/configuration/public-api-settings';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { ForwardedIdentityService } from '../identity/forwarded-identity.service';
import { gatewayBearerOf } from '../public-api/auth/gateway-bearer';
import { callingProjectReachOf, isReachedByCallingProject } from '../project/calling-project-reach';
import { ProjectProvenanceRepository } from '../project/project-provenance.repository';
import { isHiddenProjectReachable, isProjectAccessible } from '../project/project-visibility';
import { ProjectService, type EnsureEnvironmentResult, type ProjectActivityKind } from '../project/project.service';
import { RequestLogMode } from '../project/project.types';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { TenantService } from '../tenant/tenant.service';
import { Public } from '../tenant/tenant.decorator';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { resolveAppAddress, type AppDomains, type ResolvedAppAddress } from './app-address';
import { ProxyService } from './proxy.service';

type ProxySurface = 'agent' | 'app' | 'vscode' | 'db';

interface ProxySurfaceBody {
  surface?: ProxySurface;
}

interface AppAddressBody {
  host?: unknown;
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

interface AppAddressAnswer {
  environmentId: string;
  canonicalHost: string;
  protected: boolean;
}

type AppEnsureResponse =
  | (EnsureProxyResponse & AppAddressAnswer & { action: 'serve' })
  | (AppAddressAnswer & { action: 'redirect' });

@Public()
@Controller('internal/proxy')
export class ProxyController {
  private readonly proxyControlToken: string;
  private readonly appDomains: AppDomains;

  constructor(
    private readonly configService: ConfigService,
    private readonly proxyService: ProxyService,
    private readonly projectService: ProjectService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly tenantService: TenantService,
    private readonly agentSessionGateway: AgentSessionGateway,
    private readonly identities: ForwardedIdentityService,
    private readonly gatewayKeys: GatewayKeyService,
    private readonly provenance: ProjectProvenanceRepository,
    private readonly publicApiSettings: PublicApiSettings
  ) {
    this.proxyControlToken = this.configService.getOrThrow<string>('proxyControlToken');
    this.appDomains = {
      appsHostname: this.configService.getOrThrow<string>('appsHostname'),
      previewAppsHostname: this.configService.getOrThrow<string>('previewAppsHostname'),
    };
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

    if (surface === 'app' && env.servesAnExternalService) {
      throw new NotFoundException(`Project environment ${environmentId} not found`);
    }

    if (surface === 'agent') {
      if (!env.tenantId) throw new BadRequestException(`Project environment ${environmentId} not yet claimed`);
      await this.assertSurfaceAccess(env.tenantId, env.projectId, request);
    }

    const ensured =
      surface === 'agent'
        ? await this.agentSessionGateway.ensureAgentSurface(env)
        : await this.projectService.ensureEnvironment(env, activityForSurface(surface));

    const response = this.toEnsureResponse(surface, ensured);
    if (surface !== 'app') return response;
    const hostOlderAppProxiesRedirectTo = legacyAppHost(env.id, env.environmentSlug, this.appDomains.appsHostname);
    return { ...response, canonicalHost: hostOlderAppProxiesRedirectTo };
  }

  @Post('apps/ensure')
  async ensureApp(
    @Body() body: AppAddressBody,
    @Headers('x-proxy-control-token') token: string | undefined
  ): Promise<AppEnsureResponse> {
    this.assertToken(token);

    const host = requireAppHost(body);
    const address = await resolveAppAddress(host, this.appDomains, this.projectEnvironmentService);
    if (!address || address.env.servesAnExternalService) {
      throw new NotFoundException(`No App answers on ${host}`);
    }

    return this.answerAppAddress(address);
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

  private async answerAppAddress({ env, action, canonicalHost }: ResolvedAppAddress): Promise<AppEnsureResponse> {
    const answer: AppAddressAnswer = { environmentId: env.id, canonicalHost, protected: env.authMode !== 'public' };
    if (action === 'redirect') return { action, ...answer };

    const ensured = await this.projectService.ensureEnvironment(env, 'app');
    return { ...this.toEnsureResponse('app', ensured), action, ...answer };
  }

  private toEnsureResponse(surface: ProxySurface, ensured: EnsureEnvironmentResult): EnsureProxyResponse {
    if (ensured.state !== 'ready') {
      return { state: ensured.state };
    }

    const env = ensured.env;
    const upstream = resolveUpstreamForSurface(this.proxyService, surface, env);

    return {
      state: ensured.state,
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

  /** The third predicate beside tenant membership and project visibility (ADR-0064). */
  private async assertKindStampedVisibility(tenantId: string, projectId: string, userId: string): Promise<void> {
    if ((await this.provenance.findKind(projectId)) === null) return;
    if (await isHiddenProjectReachable(tenantId, userId, projectId)) return;
    throw new ForbiddenException("This chat's skill or agent is private to the member who created it");
  }

  private async assertGatewayCallerAccess(token: string, tenantId: string, projectId: string): Promise<void> {
    const caller = await this.gatewayKeys.validateToken(token);
    if (!caller?.projectEnvironmentId) throw new UnauthorizedException('Unknown gateway key');
    if (caller.tenantId !== tenantId) throw new NotFoundException(this.publicApiSettings.unreachedProjectDetail());
    const settings = await this.publicApiSettings.of(caller.projectEnvironmentId);
    if (settings?.driveCreatedProjects !== true) {
      throw new ForbiddenException(
        `"${this.publicApiSettings.labelOf('driveCreatedProjects')}" is off in the calling Project's configuration. ${WHO_CHANGES_PUBLIC_API_SETTINGS}`
      );
    }

    const creatorId = await this.provenance.findCreatorId(caller.projectId);
    if (!creatorId) throw new UnauthorizedException('The calling Project has no creator');

    const creator = await this.identities.resolveByPlatformId(creatorId);
    const tenant = await this.tenantService.getTenantById(tenantId);
    if (!creator || !tenant || !this.tenantService.resolveAccessibleTenantNames(creator.groups).includes(tenant.name)) {
      throw new NotFoundException(this.publicApiSettings.unreachedProjectDetail());
    }

    if (
      !(await isProjectAccessible(tenantId, creatorId, projectId)) ||
      !(await isReachedByCallingProject(projectId, callingProjectReachOf(caller.projectId, settings)))
    ) {
      throw new NotFoundException(this.publicApiSettings.unreachedProjectDetail());
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

function requireAppHost(body: AppAddressBody): string {
  if (typeof body.host !== 'string' || !body.host) throw new BadRequestException('Missing host');
  return body.host;
}

function activityForSurface(surface: ProxySurface): ProjectActivityKind {
  return surface === 'app' ? 'app' : 'agent';
}

function isProxySurface(value: string): value is ProxySurface {
  return value === 'agent' || value === 'app' || value === 'vscode' || value === 'db';
}

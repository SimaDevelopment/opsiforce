import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { ForwardedIdentityService } from '../../identity/forwarded-identity.service';
import { Perms } from '../../permission/permission.constants';
import { parsePermissions } from '../../permission/permission.utils';
import { IS_PUBLIC_KEY, TENANT_NAME_HEADER, type TenantContext } from '../../tenant/tenant.decorator';
import { TenantService } from '../../tenant/tenant.service';
import type { OrganizationRef } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';
import { ALLOWS_GATEWAY_CALLER_KEY } from './allows-gateway-caller.decorator';
import { ProjectProvenanceRepository } from '../../project/project-provenance.repository';
import type { Caller, CallerRequest } from './caller';
import { gatewayBearerOf } from './gateway-bearer';

function toRef({ tenantId, tenantName }: TenantContext): OrganizationRef {
  return { id: tenantId, name: tenantName };
}

@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantService: TenantService,
    private readonly identities: ForwardedIdentityService,
    private readonly gatewayKeys: GatewayKeyService,
    private readonly provenance: ProjectProvenanceRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<CallerRequest>();
    const gatewayToken = gatewayBearerOf(request.headers);

    request.caller = gatewayToken
      ? await this.gatewayCaller(gatewayToken, context)
      : await this.forwardedCaller(request);
    return true;
  }

  private async forwardedCaller(request: CallerRequest): Promise<Caller> {
    const forwarded = this.identities.read(request);
    const { tenantContext } = request;
    if (!forwarded || !tenantContext) throw Errors.unauthenticated();

    const permissions = new Set(parsePermissions(forwarded.groups));
    if (!permissions.has(Perms.usePublicApi)) throw Errors.permissionDenied(Perms.usePublicApi);

    const organizations = await this.resolveOrganizations(forwarded.groups, tenantContext);
    if (organizations.length > 1 && !request.headers[TENANT_NAME_HEADER]) {
      throw Errors.organizationRequired(organizations);
    }

    const identity = await this.identities.resolve(forwarded, tenantContext.tenantId);

    return {
      source: 'idp-bearer',
      user: {
        id: identity.keycloakId,
        platformId: identity.platformId,
        username: identity.username,
        email: identity.platformEmail,
        displayName: identity.displayName,
        kind: identity.kind,
      },
      organization: toRef(tenantContext),
      organizations,
      permissions,
    };
  }

  private async gatewayCaller(token: string, context: ExecutionContext): Promise<Caller> {
    const key = await this.gatewayKeys.validateToken(token, 'platform-api');
    if (!key?.tenantId) throw Errors.unauthenticated();

    const creatorId = await this.provenance.findCreatorId(key.projectId);
    if (!creatorId) throw Errors.unauthenticated();

    const identity = await this.identities.resolveByPlatformId(creatorId);
    if (!identity) throw Errors.unauthenticated();

    const tenant = await this.tenantService.getTenantById(key.tenantId);
    if (!tenant) throw Errors.unauthenticated();
    if (!this.tenantService.resolveAccessibleTenantNames(identity.groups).includes(tenant.name)) {
      throw Errors.organizationForbidden();
    }

    this.assertRouteOpenToGatewayCaller(context);

    const organization: OrganizationRef = { id: tenant.id, name: tenant.name };
    return {
      source: 'gateway-key',
      projectId: key.projectId,
      user: {
        id: identity.keycloakId,
        platformId: identity.platformId,
        username: identity.username,
        email: identity.platformEmail,
        displayName: identity.displayName,
        kind: identity.kind,
      },
      organization,
      organizations: [organization],
      permissions: new Set(parsePermissions(identity.groups)),
    };
  }

  private assertRouteOpenToGatewayCaller(context: ExecutionContext): void {
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOWS_GATEWAY_CALLER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) throw Errors.routeClosedToAgentCaller();
  }

  private async resolveOrganizations(groups: string, tenantContext: TenantContext): Promise<OrganizationRef[]> {
    const names = this.tenantService.resolveAccessibleTenantNames(groups);
    if (names.length === 1) return [toRef(tenantContext)];
    const tenants = await this.tenantService.getOrCreateTenants(names);
    return tenants.map(({ id, name }) => ({ id, name }));
  }
}

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForwardedIdentityService } from '../../identity/forwarded-identity.service';
import { Perms } from '../../permission/permission.constants';
import { parsePermissions } from '../../permission/permission.utils';
import { IS_PUBLIC_KEY, TENANT_NAME_HEADER, type TenantContext } from '../../tenant/tenant.decorator';
import { TenantService } from '../../tenant/tenant.service';
import type { TenantRef } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';
import { CallTokens } from '../../gateway/call-tokens';
import { PUBLIC_API_SERVICE } from '../../external-services/configuration/operation-switches';
import { EXTERNAL_SERVICE_OPERATION_KEY } from './external-service-operation.decorator';
import { ProjectProvenanceRepository } from '../../project/project-provenance.repository';
import type { Caller, CallerRequest } from './caller';
import { podBearerOf, type PodBearer } from './gateway-bearer';

function toRef({ tenantId, tenantName }: TenantContext): TenantRef {
  return { id: tenantId, name: tenantName };
}

@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantService: TenantService,
    private readonly identities: ForwardedIdentityService,
    private readonly callTokens: CallTokens,
    private readonly provenance: ProjectProvenanceRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<CallerRequest>();
    const podBearer = podBearerOf(request.headers);

    request.caller = podBearer ? await this.podCaller(podBearer, context) : await this.forwardedCaller(request);
    return true;
  }

  private async forwardedCaller(request: CallerRequest): Promise<Caller> {
    const forwarded = this.identities.read(request);
    const { tenantContext } = request;
    if (!forwarded || !tenantContext) throw Errors.unauthenticated();

    const permissions = new Set(parsePermissions(forwarded.groups));
    if (!permissions.has(Perms.usePublicApi)) throw Errors.permissionDenied(Perms.usePublicApi);

    const tenants = await this.resolveTenants(forwarded.groups, tenantContext);
    if (tenants.length > 1 && !request.headers[TENANT_NAME_HEADER]) {
      throw Errors.tenantRequired(tenants);
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
      tenant: toRef(tenantContext),
      tenants,
      permissions,
    };
  }

  private async podCaller(bearer: PodBearer, context: ExecutionContext): Promise<Caller> {
    const routeOperation = this.reflector.getAllAndOverride<string | undefined>(EXTERNAL_SERVICE_OPERATION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const key = bearer.kind === 'call-token' ? this.callTokens.redeem(bearer.token, routeOperation) : null;
    if (key?.service !== PUBLIC_API_SERVICE) throw Errors.unauthenticated();

    const creatorId = await this.provenance.findCreatorId(key.projectId);
    if (!creatorId) throw Errors.unauthenticated();

    const identity = await this.identities.resolveByPlatformId(creatorId);
    if (!identity) throw Errors.unauthenticated();

    const tenantRow = await this.tenantService.getTenantById(key.tenantId);
    if (!tenantRow) throw Errors.unauthenticated();
    if (!this.tenantService.resolveAccessibleTenantNames(identity.groups).includes(tenantRow.name)) {
      throw Errors.tenantForbidden();
    }

    if (!routeOperation) throw Errors.routeClosedToAgentCaller();

    const tenant: TenantRef = { id: tenantRow.id, name: tenantRow.name };
    return {
      source: 'call-token',
      projectId: key.projectId,
      user: {
        id: identity.keycloakId,
        platformId: identity.platformId,
        username: identity.username,
        email: identity.platformEmail,
        displayName: identity.displayName,
        kind: identity.kind,
      },
      tenant,
      tenants: [tenant],
      permissions: new Set(parsePermissions(identity.groups)),
    };
  }

  private async resolveTenants(groups: string, tenantContext: TenantContext): Promise<TenantRef[]> {
    const names = this.tenantService.resolveAccessibleTenantNames(groups);
    if (names.length === 1) return [toRef(tenantContext)];
    const tenants = await this.tenantService.getOrCreateTenants(names);
    return tenants.map(({ id, name }) => ({ id, name }));
  }
}

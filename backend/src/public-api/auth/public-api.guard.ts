import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForwardedIdentityService } from '../../identity/forwarded-identity.service';
import { parsePermissions } from '../../permission/permission.utils';
import { IS_PUBLIC_KEY, TENANT_NAME_HEADER, type TenantContext } from '../../tenant/tenant.decorator';
import { TenantService } from '../../tenant/tenant.service';
import type { TenantRef } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';
import { verifyCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { builtInCallerKey } from '../../external-services/built-ins/built-in-caller-key';
import { PUBLIC_API_SERVICE } from '../../external-services/built-ins/public-api-service';
import { SecretSealer } from '../../sealing/secret-sealer';
import { SERVICE_ROUTE_KEY } from './service-route.decorator';
import { ProjectProvenanceRepository } from '../../project/project-provenance.repository';
import type { Caller, CallerRequest } from './caller';
import { podCredentialOf, type PodCredential } from './gateway-bearer';

function toRef({ tenantId, tenantName }: TenantContext): TenantRef {
  return { id: tenantId, name: tenantName };
}

@Injectable()
export class PublicApiGuard implements CanActivate {
  private readonly callerKey: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantService: TenantService,
    private readonly identities: ForwardedIdentityService,
    private readonly provenance: ProjectProvenanceRepository,
    sealer: SecretSealer
  ) {
    this.callerKey = builtInCallerKey(sealer, PUBLIC_API_SERVICE);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<CallerRequest>();
    const podCredential = podCredentialOf(request.headers);

    request.caller = podCredential ? await this.podCaller(podCredential, context) : await this.forwardedCaller(request);
    return true;
  }

  private async forwardedCaller(request: CallerRequest): Promise<Caller> {
    const forwarded = this.identities.read(request);
    const { tenantContext } = request;
    if (!forwarded || !tenantContext) throw Errors.unauthenticated();

    const permissions = new Set(parsePermissions(forwarded.groups));
    if (!permissions.has('can_use_public_api')) throw Errors.permissionDenied('can_use_public_api');

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

  private async podCaller(credential: PodCredential, context: ExecutionContext): Promise<Caller> {
    const serviceRoute = this.reflector.getAllAndOverride<object | undefined>(SERVICE_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const key =
      credential.kind === 'caller-identity' ? verifyCallerIdentity(credential.token, this.callerKey) : undefined;
    if (key?.kind !== 'call' || !key.projectId || !key.projectEnvironmentId) throw Errors.unauthenticated();

    const creatorId = await this.provenance.findCreatorId(key.projectId);
    if (!creatorId) throw Errors.unauthenticated();

    const identity = await this.identities.resolveByPlatformId(creatorId);
    if (!identity) throw Errors.unauthenticated();

    const tenantRow = await this.tenantService.getTenantById(key.tenantId);
    if (!tenantRow) throw Errors.unauthenticated();
    if (!this.tenantService.resolveAccessibleTenantNames(identity.groups).includes(tenantRow.name)) {
      throw Errors.tenantForbidden();
    }

    if (!serviceRoute) throw Errors.routeClosedToAgentCaller();

    const tenant: TenantRef = { id: tenantRow.id, name: tenantRow.name };
    return {
      source: 'caller-identity',
      projectId: key.projectId,
      projectEnvironmentId: key.projectEnvironmentId,
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

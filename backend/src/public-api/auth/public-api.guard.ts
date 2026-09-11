import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForwardedIdentityService } from '../../identity/forwarded-identity.service';
import { Perms } from '../../permission/permission.constants';
import { parsePermissions } from '../../permission/permission.utils';
import { IS_PUBLIC_KEY, TENANT_NAME_HEADER, type TenantContext } from '../../tenant/tenant.decorator';
import { TenantService } from '../../tenant/tenant.service';
import type { OrganizationRef } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';
import type { CallerRequest } from './caller';

function toRef({ tenantId, tenantName }: TenantContext): OrganizationRef {
  return { id: tenantId, name: tenantName };
}

@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantService: TenantService,
    private readonly identities: ForwardedIdentityService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<CallerRequest>();
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

    request.caller = {
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
    return true;
  }

  private async resolveOrganizations(groups: string, tenantContext: TenantContext): Promise<OrganizationRef[]> {
    const names = this.tenantService.resolveAccessibleTenantNames(groups);
    if (names.length === 1) return [toRef(tenantContext)];
    const tenants = await this.tenantService.getOrCreateTenants(names);
    return tenants.map(({ id, name }) => ({ id, name }));
  }
}

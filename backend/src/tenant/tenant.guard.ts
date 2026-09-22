import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { TenantService } from './tenant.service';
import { TenantAccessDeniedException } from './tenant-access-denied.exception';
import { IS_PLATFORM_SCOPE_KEY, IS_PUBLIC_KEY, TENANT_NAME_HEADER, type TenantContext } from './tenant.decorator';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly tenantService: TenantService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { tenantContext: TenantContext }>();
    const groupsHeader = (request.headers['x-forwarded-groups'] as string | undefined) ?? '';

    const isPlatformScope = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatformScope) {
      if (!groupsHeader) throw new ForbiddenException('Not authenticated');
      return true;
    }

    const tenantNames = this.tenantService.resolveAccessibleTenantNames(groupsHeader);
    if (tenantNames.length === 0) throw new TenantAccessDeniedException('No opsiforce tenants assigned');

    const query = request.query as { tenant?: string } | undefined;
    const requestedTenantName =
      (request.headers[TENANT_NAME_HEADER] as string | undefined) ?? query?.tenant ?? tenantNames[0];

    if (!tenantNames.includes(requestedTenantName)) {
      throw new TenantAccessDeniedException(`No access to tenant: ${requestedTenantName}`);
    }

    const tenant = await this.tenantService.getOrCreateTenant(requestedTenantName);

    request.tenantContext = { tenantId: tenant.id, tenantName: tenant.name };
    return true;
  }
}

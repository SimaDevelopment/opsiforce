import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

export interface TenantContext {
  tenantId: string;
  tenantName: string;
}

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest & { tenantContext: TenantContext }>();
  return request.tenantContext;
});

export const TENANT_NAME_HEADER = 'x-tenant-name';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_PLATFORM_SCOPE_KEY = 'isPlatformScope';
export const PlatformScope = () => SetMetadata(IS_PLATFORM_SCOPE_KEY, true);

export const RESOLVES_OWN_TENANT_KEY = 'resolvesOwnTenant';
export const ResolvesOwnTenant = () => SetMetadata(RESOLVES_OWN_TENANT_KEY, true);

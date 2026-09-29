import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '../../tenant/tenant.decorator';
import type { IdentityKind } from '../../identity/forwarded-identity.service';
import type { TenantRef } from '../errors/error.schema';
import { Errors } from '../errors/public-api-error';

export type CallerSource = 'idp-bearer' | 'gateway-key';
export type CallerUserKind = IdentityKind;

export interface Caller {
  source: CallerSource;
  projectId?: string;
  user: {
    id: string;
    platformId: string;
    username: string;
    email: string | null;
    displayName: string;
    kind: CallerUserKind;
  };
  tenant: TenantRef;
  tenants: TenantRef[];
  permissions: ReadonlySet<string>;
}

export type CallerRequest = FastifyRequest & { caller?: Caller; tenantContext?: TenantContext };

export const Caller = createParamDecorator((_data: unknown, ctx: ExecutionContext): Caller => {
  const { caller } = ctx.switchToHttp().getRequest<CallerRequest>();
  if (!caller) throw new InternalServerErrorException('PublicApiGuard did not run');
  return caller;
});

export function assertPermission(caller: Caller, permission: string): void {
  if (!caller.permissions.has(permission)) throw Errors.permissionDenied(permission);
}

export function chatProjectIdOf(caller: Caller): string | null {
  return caller.source === 'gateway-key' ? (caller.projectId ?? null) : null;
}

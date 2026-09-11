import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '../../tenant/tenant.decorator';
import type { IdentityKind } from '../../identity/forwarded-identity.service';
import type { OrganizationRef } from '../errors/error.schema';

export type CallerSource = 'idp-bearer';
export type CallerUserKind = IdentityKind;

export interface Caller {
  source: CallerSource;
  user: {
    id: string;
    platformId: string;
    username: string;
    email: string | null;
    displayName: string;
    kind: CallerUserKind;
  };
  organization: OrganizationRef;
  organizations: OrganizationRef[];
  permissions: ReadonlySet<string>;
}

export type CallerRequest = FastifyRequest & { caller?: Caller; tenantContext?: TenantContext };

export const Caller = createParamDecorator((_data: unknown, ctx: ExecutionContext): Caller => {
  const { caller } = ctx.switchToHttp().getRequest<CallerRequest>();
  if (!caller) throw new InternalServerErrorException('PublicApiGuard did not run');
  return caller;
});

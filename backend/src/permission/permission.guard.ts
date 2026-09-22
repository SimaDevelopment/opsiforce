import { Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getGroupsHeader, hasPermission } from './permission.utils';
import { MissingPermissionException } from './missing-permission.exception';

const REQUIRED_PERMISSION_KEY = 'requiredPermission';
const REQUIRED_ANY_PERMISSION_KEY = 'requiredAnyPermission';
export const RELAXED_PERMISSION_KEY = 'relaxedPermission';

export const RequirePermission = (permission: string) => SetMetadata(REQUIRED_PERMISSION_KEY, permission);

/** Either permission opens the door, as the Builder's two authoring permissions do. */
export const RequireAnyPermission = (permissions: readonly string[]) =>
  SetMetadata(REQUIRED_ANY_PERMISSION_KEY, permissions);

export const RelaxPermission = () => SetMetadata(RELAXED_PERMISSION_KEY, true);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.get<boolean | undefined>(RELAXED_PERMISSION_KEY, context.getHandler())) return true;

    const request = context.switchToHttp().getRequest();
    const groups = getGroupsHeader(request);

    const permission = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (permission && !hasPermission(groups, permission)) {
      throw new MissingPermissionException(permission);
    }

    const anyOf = this.reflector.getAllAndOverride<readonly string[] | undefined>(REQUIRED_ANY_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (anyOf && anyOf.length > 0 && !anyOf.some((candidate) => hasPermission(groups, candidate))) {
      throw new MissingPermissionException(anyOf.join(' or '));
    }

    return true;
  }
}

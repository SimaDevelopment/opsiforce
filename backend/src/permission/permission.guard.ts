import { Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getGroupsHeader, hasPermission } from './permission.utils';
import { MissingPermissionException } from './missing-permission.exception';

const REQUIRED_PERMISSION_KEY = 'requiredPermission';

export const RequirePermission = (permission: string) => SetMetadata(REQUIRED_PERMISSION_KEY, permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;

    const request = context.switchToHttp().getRequest();
    if (!hasPermission(getGroupsHeader(request), permission)) {
      throw new MissingPermissionException(permission);
    }

    return true;
  }
}

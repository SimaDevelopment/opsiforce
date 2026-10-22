import type { ExternalServiceOrigin } from '~/api/external-service-views';
import { Permission } from '~/constants/permissions';

type HasPermission = (permission: string) => boolean;

export function canSeeExternalServices(hasPermission: HasPermission): boolean {
  return (
    hasPermission(Permission.managePlatformExternalServices) || hasPermission(Permission.manageTenantExternalServices)
  );
}

export function canManageExternalService(origin: ExternalServiceOrigin, hasPermission: HasPermission): boolean {
  return origin === 'built_in'
    ? hasPermission(Permission.managePlatformExternalServices)
    : hasPermission(Permission.manageTenantExternalServices);
}

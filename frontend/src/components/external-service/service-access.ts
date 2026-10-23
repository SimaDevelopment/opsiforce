import type { ExternalServiceOrigin } from '~/api/external-service-views';
import type { HasPermission } from '~/constants/permissions';

export function canSeeExternalServices(hasPermission: HasPermission): boolean {
  return hasPermission('can_manage_platform_external_services') || hasPermission('can_manage_tenant_external_services');
}

export function canManageExternalService(origin: ExternalServiceOrigin, hasPermission: HasPermission): boolean {
  return origin === 'built_in'
    ? hasPermission('can_manage_platform_external_services')
    : hasPermission('can_manage_tenant_external_services');
}

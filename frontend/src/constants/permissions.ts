import type { Permission } from '../../../backend/src/permission/permission.constants';

export type { Permission };

export type HasPermission = (permission: Permission) => boolean;

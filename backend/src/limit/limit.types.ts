import type { LimitKeyValue } from '../../db/schema';

export type LimitKey = LimitKeyValue;

export interface LimitUsage {
  key: LimitKey;
  limit: number | null;
  used: number;
}

export interface PlatformLimit {
  key: LimitKey;
  value: number | null;
}

export interface TenantLimit extends LimitUsage {
  overridden: boolean;
}

export interface TenantLimits {
  tenantId: string;
  displayName: string;
  limits: TenantLimit[];
}

export interface PlatformLimitsView {
  platform: PlatformLimit[];
  tenants: TenantLimits[];
}

export interface SetLimitDto {
  value: number | null;
}

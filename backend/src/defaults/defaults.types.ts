export interface TimeoutDefaults {
  defaultTimeoutIdle: number;
  defaultAppTimeoutIdle: number;
  defaultDisableAfter: number | null;
  defaultDeleteAfter: number | null;
}

export interface BudgetDefaults {
  defaultTenantBudget: number;
  defaultTenantBudgetDuration: string;
  defaultProjectBudget: number;
  defaultProjectBudgetDuration: string;
  defaultChatBudget: number;
  defaultChatBudgetDuration: string;
  defaultBackendBudget: number;
  defaultBackendBudgetDuration: string;
}

export type UpdateTimeoutDefaultsDto = Partial<TimeoutDefaults>;
export type UpdateBudgetDefaultsDto = Partial<BudgetDefaults>;

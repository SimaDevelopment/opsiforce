export type KeyType = 'chat' | 'backend';

export interface BifrostProviderConfig {
  provider: string;
  weight?: number | null;
  allowed_models?: string[];
  key_ids?: string[];
}

export interface BifrostProviderResponse {
  name: string;
  provider_status?: string | null;
  network_config?: { base_url?: string | null } | null;
  custom_provider_config?: { base_provider_type?: string | null; is_key_less?: boolean | null } | null;
}

export interface BifrostProviderSummary {
  name: string;
  baseProviderType: string | null;
  baseUrl: string | null;
  status: string | null;
  keyLess: boolean;
}

export interface BifrostAllowedRequests {
  list_models: boolean;
  chat_completion: boolean;
  chat_completion_stream: boolean;
  responses: boolean;
  responses_stream: boolean;
  count_tokens: boolean;
}

export interface BifrostNetworkConfig {
  base_url?: string;
  allow_private_network?: boolean;
  default_request_timeout_in_seconds: number;
  max_retries: number;
  retry_backoff_initial: number;
  retry_backoff_max: number;
  stream_idle_timeout_in_seconds: number;
}

export type BifrostRequestPathOverrides = Partial<Record<keyof BifrostAllowedRequests, string>>;

export interface CreateBifrostProviderRequest {
  provider: string;
  network_config: BifrostNetworkConfig;
  concurrency_and_buffer_size?: { concurrency: number; buffer_size: number };
  custom_provider_config?: {
    base_provider_type: string;
    is_key_less: boolean;
    allowed_requests: BifrostAllowedRequests;
    request_path_overrides?: BifrostRequestPathOverrides;
  };
}

export type UpdateBifrostProviderRequest = Omit<CreateBifrostProviderRequest, 'provider'>;

export interface BifrostProviderKeySummary {
  id: string;
  name?: string;
  models?: string[];
  [field: string]: unknown;
}

export interface CreateBifrostProviderKeyRequest {
  name: string;
  value: { value: string; type: 'plain_text' };
  models: string[];
  weight: number;
  enabled: boolean;
}

export interface BifrostBudget {
  max_limit: number;
  reset_duration: string;
  current_usage?: number;
}

export interface CreateVirtualKeyRequest {
  name: string;
  description?: string;
  provider_configs?: BifrostProviderConfig[];
  budgets?: BifrostBudget[];
  team_id?: string;
  is_active?: boolean;
}

export interface BifrostVirtualKey {
  id: string;
  name: string;
  value: string;
  description: string;
  is_active: boolean;
  provider_configs: BifrostProviderConfig[];
}

export interface CreateVirtualKeyResponse {
  message: string;
  virtual_key: BifrostVirtualKey;
}

export interface DeleteVirtualKeyResponse {
  message: string;
}

export interface CreateCustomerRequest {
  name: string;
  budget?: BifrostBudget;
}

export interface BifrostCustomer {
  id: string;
  name: string;
}

export interface CreateCustomerResponse {
  message: string;
  customer: BifrostCustomer;
}

export interface CreateTeamRequest {
  name: string;
  customer_id?: string;
  budgets?: BifrostBudget[];
}

export interface BifrostTeam {
  id: string;
  name: string;
  customer_id?: string;
}

export interface CreateTeamResponse {
  message: string;
  team: BifrostTeam;
}

export interface ProjectBudgetEntry {
  keyType: KeyType;
  maxBudget: number | null;
  budgetDuration: string | null;
  currentUsage: number;
}

export interface UpdateBudgetRequest {
  keyType: KeyType;
  maxBudget: number;
  budgetDuration: string;
}

export interface ProjectBudgetResponse {
  maxBudget: number | null;
  budgetDuration: string | null;
  currentUsage: number;
}

export interface TenantBudgetResponse {
  tenantBudget: number | null;
  budgetDuration: string | null;
  currentUsage: number;
}

export interface UpdateTenantBudgetRequest {
  tenantBudget: number;
  budgetDuration: string;
}

export interface UpdateProjectBudgetRequest {
  maxBudget: number;
  budgetDuration: string;
}

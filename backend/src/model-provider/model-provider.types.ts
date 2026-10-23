import type { VendorId } from '../linked-accounts/vendor-adapter';
import type { BaseFormatId, ModelProviderKind } from './base-formats';

export type ModelProviderStatus = 'working' | 'failing' | 'not-signed-in' | 'needs-sign-in' | 'missing' | 'unknown';

export interface TenantModelProviderView {
  name: string;
  kind?: ModelProviderKind | null;
  baseUrl?: string;
  baseFormat: BaseFormatId | null;
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled: boolean;
  backendWeight: number;
  status: ModelProviderStatus;
  servedModels?: string[];
  connection?: AzureConnectionView;
}

export interface TenantModelProvidersView {
  bifrostReachable: boolean;
  baseFormats: BaseFormatId[];
  catalogModels: Record<BaseFormatId, string[]>;
  providers: TenantModelProviderView[];
}

export type AvailabilityMode = 'every' | 'chosen';

export interface ModelProviderSwitch {
  name: string;
  chatEnabled?: boolean;
  chatWeight?: number;
  backendEnabled?: boolean;
  backendWeight?: number;
}

export interface SaveBaseFormatDto {
  providers: ModelProviderSwitch[];
  acknowledgeAffectedAgents?: boolean;
}

export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 100;
export const STARTING_WEIGHT = 1;
export const WEIGHT_RULE_MESSAGE = 'At least one enabled provider needs a weight above 0';
export const APP_WEIGHT_RULE_MESSAGE = 'At least one provider on for Apps needs an App weight above 0';
export const BIFROST_UNREACHABLE_MESSAGE = "The model gateway can't be reached, so changes can't be saved";

export const CUSTOM_MODEL_PROVIDER_LIMIT = 10;

export interface ModelProviderConnectionDto {
  baseFormat: string;
  kind: string;
  key: string;
  baseUrl?: string;
  models?: string[];
  endpoint?: string;
  deployments?: Record<string, string>;
}

export interface NewModelProviderDto extends ModelProviderConnectionDto {
  name: string;
}

export interface EditModelProviderConnectionDto {
  key: string;
  baseUrl?: string;
  endpoint?: string;
}

export interface SetModelProviderModelsDto {
  models: string[] | null;
  deployments?: Record<string, string>;
}

export interface ModelProviderCreationRules {
  nameMaxLength: number;
  customProviderLimit: number;
  customProviderCount: number;
  kindsByFormat: Record<BaseFormatId, ModelProviderKind[]>;
  catalogModels: Record<BaseFormatId, string[]>;
}

export interface ConnectionTestPassed {
  passed: true;
}

export interface PlatformModelProviderView {
  name: string;
  baseFormat: BaseFormatId | null;
  kind: ModelProviderKind | null;
  url: string | null;
  status: ModelProviderStatus;
  fixed: boolean;
  notMetered: boolean;
  servedModels?: string[];
  connection?: AzureConnectionView;
  linkedAccountVendor?: VendorId;
}

export interface AzureConnectionView {
  models: string[];
  deployments: Record<string, string>;
}

export interface PlatformModelProvidersView {
  bifrostReachable: boolean;
  providers: PlatformModelProviderView[];
}

export interface PlatformModelProviderCreationRules {
  namePrefix: string;
  nameMaxLength: number;
  kindsByFormat: Record<BaseFormatId, ModelProviderKind[]>;
  catalogModels: Record<BaseFormatId, string[]>;
}

export interface ModelProviderAccessProvider {
  name: string;
  baseFormats: BaseFormatId[];
  mode: AvailabilityMode;
}

export interface TenantModelProviderAccess {
  tenantId: string;
  name: string;
  displayName: string;
  withheld: string[];
}

export interface PlatformModelProviderAccessView {
  providers: ModelProviderAccessProvider[];
  tenants: TenantModelProviderAccess[];
}

export interface SetModelProviderAccessDto {
  withheld: boolean;
}

export interface SetModelProviderAvailabilityModeDto {
  mode: AvailabilityMode;
}

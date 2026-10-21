import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { agentKeys } from './agents';
import { ApiError, api } from './client';
import { transcriptionAvailabilityKey } from './transcription';
import { createAppQuery } from '~/lib/create-app-query';

export const BASE_FORMAT_IDS = ['openai', 'anthropic'] as const;

export type BaseFormatId = (typeof BASE_FORMAT_IDS)[number];

export type ModelProviderStatus = 'working' | 'failing' | 'not-signed-in' | 'needs-sign-in' | 'missing' | 'unknown';

export type ModelProviderKind = 'official-api-key' | 'compatible-endpoint' | 'linked-account' | 'azure-foundry';

export type AvailabilityMode = 'every' | 'chosen';

export interface AzureConnection {
  models: string[];
  deployments: Record<string, string>;
}

export interface TenantModelProvider {
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
  connection?: AzureConnection;
}

export interface TenantModelProviders {
  bifrostReachable: boolean;
  baseFormats: BaseFormatId[];
  catalogModels: Record<BaseFormatId, string[]>;
  providers: TenantModelProvider[];
}

export interface ModelProviderSwitch {
  name: string;
  chatEnabled?: boolean;
  chatWeight?: number;
  backendEnabled?: boolean;
  backendWeight?: number;
}

export interface ModelProviderCreationRules {
  nameMaxLength: number;
  customProviderLimit: number;
  customProviderCount: number;
  kindsByFormat: Record<BaseFormatId, ModelProviderKind[]>;
  catalogModels: Record<BaseFormatId, string[]>;
}

export interface ModelProviderConnection {
  baseFormat: BaseFormatId;
  kind: ModelProviderKind;
  key: string;
  baseUrl?: string;
  models?: string[];
  endpoint?: string;
  deployments?: Record<string, string>;
}

export type NewProviderAvailability = { mode: 'every' } | { mode: 'chosen'; tenantIds: string[] };

export interface NewModelProvider extends ModelProviderConnection {
  name: string;
  availability?: NewProviderAvailability;
}

export interface ModelProviderConnectionEdit {
  key: string;
  baseUrl?: string;
  models?: string[];
  endpoint?: string;
  deployments?: Record<string, string>;
}

export interface PlatformModelProvider {
  name: string;
  baseFormat: BaseFormatId | null;
  kind: ModelProviderKind | null;
  url: string | null;
  status: ModelProviderStatus;
  fixed: boolean;
  notMetered: boolean;
  deploymentManaged: boolean;
  servedModels?: string[];
  connection?: AzureConnection;
  linkedAccountVendor?: LinkedAccountVendor;
}

export interface PlatformModelProviders {
  bifrostReachable: boolean;
  providers: PlatformModelProvider[];
}

export interface NewLinkedAccount {
  baseFormat: BaseFormatId;
  kind: 'linked-account';
  vendor: LinkedAccountVendor;
  name: string;
  availability?: NewProviderAvailability;
}

export type NewCustomModelProvider = NewModelProvider | NewLinkedAccount;

export interface PlatformModelProviderCreationRules {
  namePrefix: string;
  nameMaxLength: number;
  kindsByFormat: Record<BaseFormatId, ModelProviderKind[]>;
  catalogModels: Record<BaseFormatId, string[]>;
}

export type ModelProviderScope = 'tenant' | 'platform';

export type LinkedAccountVendor = 'chatgpt';

export type LinkedAccountState = 'connected' | 'needs-sign-in' | 'awaiting-sign-in';

export type LinkedAccountSignIn =
  | { state: 'pending'; userCode: string; verificationUrl: string; expiresAt: string }
  | { state: 'expired' }
  | { state: 'failed'; message: string };

export interface LinkedAccount {
  vendor: LinkedAccountVendor;
  state: LinkedAccountState;
  signedInAs: string | null;
  reason: string | null;
  signIn: LinkedAccountSignIn | null;
}

export interface LinkedAccountUsageWindow {
  windowMinutes: number;
  usedPercent: number;
  resetsAt: string | null;
}

export interface LinkedAccountUsage {
  plan: string | null;
  windows: LinkedAccountUsageWindow[];
}

export interface StartedSignIn {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface AffectedAgent {
  id: string;
  name: string;
  origin: 'custom' | 'built_in';
}

export const AGENTS_AFFECTED_CODE = 'agents_affected';

export interface ModelProviderAccessProvider {
  name: string;
  baseFormats: BaseFormatId[];
  mode: AvailabilityMode;
}

export interface TenantModelProviderAccess {
  tenantId: string;
  displayName: string;
  withheld: string[];
}

export interface PlatformModelProviderAccess {
  providers: ModelProviderAccessProvider[];
  tenants: TenantModelProviderAccess[];
}

const tenantModelProvidersKey = ['model-providers'] as const;
const reachableModelsKey = ['model-providers', 'reachable-models'] as const;
const creationRulesKey = ['model-providers', 'creation-rules'] as const;
const platformModelProvidersKey = ['platform-model-providers'] as const;
const platformCreationRulesKey = ['platform-model-providers', 'creation-rules'] as const;
const platformAccessKey = ['platform-model-providers', 'access'] as const;
const SCOPE_PATH: Record<ModelProviderScope, string> = {
  tenant: '/model-providers',
  platform: '/platform-model-providers',
};

export function useTenantModelProviders(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: tenantModelProvidersKey,
    queryFn: () => api.get<TenantModelProviders>('/model-providers'),
    enabled: enabled(),
  }));
}

export function useSaveBaseFormat() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: {
      format: BaseFormatId;
      providers: ModelProviderSwitch[];
      acknowledgeAffectedAgents?: boolean;
    }) =>
      api.put<TenantModelProviders>(`/model-providers/formats/${vars.format}`, {
        providers: vars.providers,
        acknowledgeAffectedAgents: vars.acknowledgeAffectedAgents,
      }),
    onSuccess: (view: TenantModelProviders) => {
      qc.setQueryData(tenantModelProvidersKey, view);
      invalidateReachability(qc);
    },
  }));
}

export function useReachableModels() {
  return createAppQuery(() => ({
    queryKey: reachableModelsKey,
    queryFn: () => api.get<string[]>('/model-providers/reachable-models'),
  }));
}

function invalidateReachability(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: reachableModelsKey });
  void qc.invalidateQueries({ queryKey: agentKeys.models() });
  void qc.invalidateQueries({ queryKey: transcriptionAvailabilityKey });
}

export function useModelProviderCreationRules(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: creationRulesKey,
    queryFn: () => api.get<ModelProviderCreationRules>('/model-providers/creation-rules'),
    enabled: enabled(),
  }));
}

export function usePlatformModelProviders(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: platformModelProvidersKey,
    queryFn: () => api.get<PlatformModelProviders>('/platform-model-providers'),
    enabled: enabled(),
  }));
}

export function usePlatformModelProviderCreationRules(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: platformCreationRulesKey,
    queryFn: () => api.get<PlatformModelProviderCreationRules>('/platform-model-providers/creation-rules'),
    enabled: enabled(),
  }));
}

export function usePlatformModelProviderAccess(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: platformAccessKey,
    queryFn: () => api.get<PlatformModelProviderAccess>('/platform-model-providers/access'),
    enabled: enabled(),
  }));
}

export function useSetAvailabilityMode() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { name: string; mode: AvailabilityMode }) =>
      api.put<PlatformModelProviderAccess>(`/platform-model-providers/${encodeURIComponent(vars.name)}/availability`, {
        mode: vars.mode,
      }),
    onSuccess: (view: PlatformModelProviderAccess) => qc.setQueryData(platformAccessKey, view),
  }));
}

export interface KeysRewrite {
  organizations: number;
  failed: { tenantId: string; displayName: string }[];
}

export function useRewriteEveryOrganizationsKeys() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: () => api.post<KeysRewrite>('/platform-model-providers/rewrite-keys', {}),
    onSuccess: () => invalidateReachability(qc),
  }));
}

export function useSetModelProviderAccess() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (vars: { name: string; tenantId: string; withheld: boolean }) =>
      api.put<PlatformModelProviderAccess>(
        `/platform-model-providers/${encodeURIComponent(vars.name)}/access/${encodeURIComponent(vars.tenantId)}`,
        { withheld: vars.withheld }
      ),
    onSuccess: (view: PlatformModelProviderAccess) => {
      qc.setQueryData(platformAccessKey, view);
      void qc.invalidateQueries({ queryKey: tenantModelProvidersKey, exact: true });
      invalidateReachability(qc);
    },
  }));
}

function useApplyView(scope: ModelProviderScope) {
  const qc = useQueryClient();
  return (view: TenantModelProviders | PlatformModelProviders) => {
    if (scope === 'platform') {
      qc.setQueryData(platformModelProvidersKey, view);
      void qc.invalidateQueries({ queryKey: platformAccessKey });
      void qc.invalidateQueries({ queryKey: tenantModelProvidersKey, exact: true });
    } else {
      qc.setQueryData(tenantModelProvidersKey, view);
      void qc.invalidateQueries({ queryKey: creationRulesKey });
    }
    invalidateReachability(qc);
  };
}

export function useTestModelProvider(scope: ModelProviderScope = 'tenant') {
  return createMutation(() => ({
    mutationFn: (provider: NewModelProvider) => api.post<{ passed: true }>(`${SCOPE_PATH[scope]}/test`, provider),
  }));
}

export function useCreateModelProvider(scope: ModelProviderScope = 'tenant') {
  const applyView = useApplyView(scope);
  return createMutation(() => ({
    mutationFn: (provider: NewCustomModelProvider) =>
      api.post<TenantModelProviders | PlatformModelProviders>(SCOPE_PATH[scope], provider),
    onSuccess: applyView,
  }));
}

export function useEditModelProviderConnection(scope: ModelProviderScope = 'tenant') {
  const applyView = useApplyView(scope);
  return createMutation(() => ({
    mutationFn: (vars: { name: string; edit: ModelProviderConnectionEdit }) =>
      api.patch<TenantModelProviders | PlatformModelProviders>(
        `${SCOPE_PATH[scope]}/${encodeURIComponent(vars.name)}`,
        vars.edit
      ),
    onSuccess: applyView,
  }));
}

export function useReenterModelProviderKey(scope: ModelProviderScope = 'tenant') {
  const applyView = useApplyView(scope);
  return createMutation(() => ({
    mutationFn: (vars: { name: string; connection: ModelProviderConnection }) =>
      api.post<TenantModelProviders | PlatformModelProviders>(
        `${SCOPE_PATH[scope]}/${encodeURIComponent(vars.name)}/re-enter-key`,
        vars.connection
      ),
    onSuccess: applyView,
  }));
}

export function useDeleteModelProvider(scope: ModelProviderScope = 'tenant') {
  const applyView = useApplyView(scope);
  return createMutation(() => ({
    mutationFn: (name: string) =>
      api.delete<TenantModelProviders | PlatformModelProviders>(`${SCOPE_PATH[scope]}/${encodeURIComponent(name)}`),
    onSuccess: applyView,
  }));
}

const SIGN_IN_POLL_MS = 3000;
const USAGE_POLL_MS = 60_000;

const linkedAccountKey = (scope: ModelProviderScope, name: string) =>
  [scope === 'platform' ? 'platform-model-providers' : 'model-providers', 'linked-account', name] as const;

function linkedAccountPath(scope: ModelProviderScope, name: string): string {
  return `${SCOPE_PATH[scope]}/${encodeURIComponent(name)}`;
}

function invalidateProviderViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: platformModelProvidersKey, exact: true });
  void qc.invalidateQueries({ queryKey: tenantModelProvidersKey, exact: true });
  invalidateReachability(qc);
}

function isSigningIn(account: LinkedAccount | undefined): boolean {
  return account?.signIn?.state === 'pending';
}

export function useLinkedAccount(scope: ModelProviderScope, name: () => string, enabled: () => boolean = () => true) {
  const qc = useQueryClient();
  return createAppQuery(() => ({
    queryKey: linkedAccountKey(scope, name()),
    queryFn: async () => {
      const previous = qc.getQueryData<LinkedAccount>(linkedAccountKey(scope, name()));
      const account = await api.get<LinkedAccount>(`${linkedAccountPath(scope, name())}/linked-account`);
      if (previous && previous.state !== account.state) invalidateProviderViews(qc);
      return account;
    },
    refetchInterval: (query: { state: { data?: LinkedAccount } }) =>
      isSigningIn(query.state.data) ? SIGN_IN_POLL_MS : false,
    enabled: enabled(),
  }));
}

export function useLinkedAccountUsage(scope: ModelProviderScope, name: () => string) {
  const qc = useQueryClient();
  return createAppQuery(() => ({
    queryKey: [...linkedAccountKey(scope, name()), 'usage'] as const,
    queryFn: async () => {
      try {
        return await api.get<LinkedAccountUsage>(`${linkedAccountPath(scope, name())}/linked-account/usage`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          void qc.invalidateQueries({ queryKey: linkedAccountKey(scope, name()), exact: true });
        }
        throw err;
      }
    },
    refetchInterval: USAGE_POLL_MS,
    retry: false,
  }));
}

export function useStartSignIn(scope: ModelProviderScope) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (name: string) => api.post<StartedSignIn>(`${linkedAccountPath(scope, name)}/sign-in`, {}),
    onSuccess: (_started: StartedSignIn, name: string) =>
      qc.invalidateQueries({ queryKey: linkedAccountKey(scope, name) }),
  }));
}

function useApplyLinkedAccount(scope: ModelProviderScope) {
  const qc = useQueryClient();
  return (account: LinkedAccount, name: string) => {
    qc.setQueryData(linkedAccountKey(scope, name), account);
    invalidateProviderViews(qc);
  };
}

export interface PastedAccessToken {
  name: string;
  accessToken: string;
}

export function usePasteAccessToken(scope: ModelProviderScope) {
  const applyAccount = useApplyLinkedAccount(scope);
  return createMutation(() => ({
    mutationFn: (pasted: PastedAccessToken) =>
      api.post<LinkedAccount>(`${linkedAccountPath(scope, pasted.name)}/access-token`, {
        accessToken: pasted.accessToken,
      }),
    onSuccess: (account: LinkedAccount, pasted: PastedAccessToken) => applyAccount(account, pasted.name),
  }));
}

export function useDisconnectLinkedAccount(scope: ModelProviderScope) {
  const applyAccount = useApplyLinkedAccount(scope);
  return createMutation(() => ({
    mutationFn: (name: string) => api.post<LinkedAccount>(`${linkedAccountPath(scope, name)}/disconnect`, {}),
    onSuccess: (account: LinkedAccount, name: string) => applyAccount(account, name),
  }));
}

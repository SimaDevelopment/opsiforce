import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, isNull } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import { projectVirtualKeys, projectEnvironments, tenants, projects } from '../../db/schema';
import { DefaultsService } from '../defaults/defaults.service';
import type { BudgetDefaults } from '../defaults/defaults.types';
import type {
  KeyType,
  BifrostBudget,
  BifrostProviderConfig,
  BifrostProviderResponse,
  BifrostProviderSummary,
  CreateVirtualKeyRequest,
  CreateVirtualKeyResponse,
  DeleteVirtualKeyResponse,
  CreateCustomerRequest,
  CreateCustomerResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  CreateBifrostProviderRequest,
  CreateBifrostProviderKeyRequest,
  BifrostProviderKeySummary,
  UpdateBifrostProviderRequest,
} from './bifrost.types';
import { BACKEND_PROVIDER_CONFIGS } from './bifrost.providers';

function providerSummaryOf(provider: BifrostProviderResponse): BifrostProviderSummary {
  return {
    name: provider.name,
    baseProviderType: provider.custom_provider_config?.base_provider_type ?? null,
    baseUrl: provider.network_config?.base_url || null,
    status: provider.provider_status ?? null,
    keyLess: provider.custom_provider_config?.is_key_less === true,
  };
}

export class BifrostApiError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    readonly responseText: string
  ) {
    super(`Bifrost API ${method} ${path} failed (${status}): ${responseText}`);
    this.name = 'BifrostApiError';
  }

  get bifrostMessage(): string {
    try {
      const parsed = JSON.parse(this.responseText) as { error?: { message?: string } | string; message?: string };
      const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
      return message ?? this.responseText;
    } catch {
      return this.responseText;
    }
  }
}

@Injectable()
export class BifrostService {
  private readonly logger = new Logger(BifrostService.name);
  private readonly proxyUrl: string;
  private readonly podProxyUrl: string;
  private readonly adminUsername: string;
  private readonly adminPassword: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly defaultsService: DefaultsService
  ) {
    this.proxyUrl = this.configService.get<string>('bifrostProxyUrl', '');
    this.podProxyUrl = this.configService.get<string>('bifrostPodProxyUrl', '') || this.proxyUrl;
    this.adminUsername = this.configService.get<string>('bifrostAdminUsername', '');
    this.adminPassword = this.configService.get<string>('bifrostAdminPassword', '');
  }

  isEnabled(): boolean {
    return !!this.proxyUrl && !!this.adminUsername && !!this.adminPassword;
  }

  private budgetFor(defaults: BudgetDefaults, level: 'tenant' | 'project' | KeyType): BifrostBudget {
    switch (level) {
      case 'tenant':
        return { max_limit: defaults.defaultTenantBudget, reset_duration: defaults.defaultTenantBudgetDuration };
      case 'project':
        return { max_limit: defaults.defaultProjectBudget, reset_duration: defaults.defaultProjectBudgetDuration };
      case 'backend':
        return { max_limit: defaults.defaultBackendBudget, reset_duration: defaults.defaultBackendBudgetDuration };
      case 'chat':
        return { max_limit: defaults.defaultChatBudget, reset_duration: defaults.defaultChatBudgetDuration };
    }
  }

  private baseUrl(): string {
    return this.proxyUrl.replace(/\/v1\/?$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    const credentials = Buffer.from(`${this.adminUsername}:${this.adminPassword}`).toString('base64');
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new BifrostApiError(method, path, response.status, await response.text());
    }

    return response.json() as Promise<T>;
  }

  async createTenantCustomer(tenantId: string, tenantName: string, budgets?: BudgetDefaults): Promise<string> {
    const [fresh] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (fresh?.bifrostTenantId) return fresh.bifrostTenantId;

    const resolvedBudgets = budgets ?? (await this.defaultsService.getTenantBudgets(tenantId));
    const payload: CreateCustomerRequest = {
      name: `tenant-${tenantName}`,
      budget: this.budgetFor(resolvedBudgets, 'tenant'),
    };

    const result = await this.request<CreateCustomerResponse>('POST', '/api/governance/customers', payload);

    const customerId = result.customer.id;
    await db
      .update(tenants)
      .set({ bifrostTenantId: customerId })
      .where(and(eq(tenants.id, tenantId), isNull(tenants.bifrostTenantId)));

    this.logger.log(`Created Bifrost customer for tenant ${tenantName}`);
    return customerId;
  }

  async updateCustomerBudget(customerId: string, budget?: BifrostBudget): Promise<void> {
    await this.request('PUT', `/api/governance/customers/${customerId}`, budget ? { budget } : {});
  }

  async getCustomerBudget(customerId: string): Promise<BifrostBudget | null> {
    const data = await this.request<{ customer: { budget?: BifrostBudget } }>(
      'GET',
      `/api/governance/customers/${customerId}`
    );
    return data.customer.budget ?? null;
  }

  async createProjectTeam(projectId: string, budgets: BudgetDefaults, customerId?: string): Promise<string> {
    const payload: CreateTeamRequest = {
      name: `project-${projectId.slice(0, 8)}`,
      ...(customerId ? { customer_id: customerId } : {}),
      budgets: [this.budgetFor(budgets, 'project')],
    };

    const result = await this.request<CreateTeamResponse>('POST', '/api/governance/teams', payload);

    const teamId = result.team.id;
    await db.update(projects).set({ bifrostProjectId: teamId }).where(eq(projects.id, projectId));

    this.logger.log(`Created Bifrost team for project ${projectId}${customerId ? '' : ' (orphan)'}`);
    return teamId;
  }

  async reassignTeamCustomer(teamId: string, customerId: string): Promise<void> {
    await this.request('PUT', `/api/governance/teams/${teamId}`, {
      customer_id: customerId,
    });
  }

  async getTeamCustomerId(teamId: string): Promise<string | null> {
    const data = await this.request<{ team: { customer_id?: string | null } }>(
      'GET',
      `/api/governance/teams/${teamId}`
    );
    return data.team.customer_id ?? null;
  }

  async updateTeamBudget(teamId: string, budget?: BifrostBudget): Promise<void> {
    await this.request('PUT', `/api/governance/teams/${teamId}`, budget ? { budgets: [budget] } : {});
  }

  async updateProjectResourceBudgets(projectId: string, teamId: string, budgets: BudgetDefaults): Promise<void> {
    const keys = await db
      .select({
        keyType: projectVirtualKeys.keyType,
        bifrostKeyId: projectVirtualKeys.bifrostKeyId,
      })
      .from(projectVirtualKeys)
      .where(and(eq(projectVirtualKeys.projectId, projectId), eq(projectVirtualKeys.status, 'active')));

    const chatKey = keys.find((key) => key.keyType === 'chat');
    const backendKey = keys.find((key) => key.keyType === 'backend');
    if (!chatKey || !backendKey) throw new Error(`Project ${projectId} is missing active Bifrost keys`);

    await Promise.all([
      this.updateTeamBudget(teamId, this.budgetFor(budgets, 'project')),
      this.updateVirtualKey(chatKey.bifrostKeyId, teamId, this.budgetFor(budgets, 'chat')),
      this.updateVirtualKey(backendKey.bifrostKeyId, teamId, this.budgetFor(budgets, 'backend')),
    ]);
  }

  private async updateVirtualKey(keyId: string, teamId: string | null, budget?: BifrostBudget): Promise<void> {
    await this.request('PUT', `/api/governance/virtual-keys/${keyId}`, {
      ...(budget ? { budgets: [budget] } : {}),
      ...(teamId ? { team_id: teamId } : {}),
    });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.request('DELETE', `/api/governance/teams/${teamId}`);
  }

  async destroyTeamAndKeys(teamId: string | null, bifrostKeyIds: string[]): Promise<void> {
    const errors: string[] = [];
    await Promise.allSettled(
      bifrostKeyIds.map(async (keyId) => {
        try {
          await this.request('DELETE', `/api/governance/virtual-keys/${keyId}`);
        } catch (err) {
          if (!this.isNotFoundError(err as Error)) {
            const message = `key ${keyId}: ${(err as Error).message}`;
            errors.push(message);
            this.logger.warn(`Failed to delete Bifrost ${message}`);
          }
        }
      })
    );
    if (teamId) {
      try {
        await this.deleteTeam(teamId);
      } catch (err) {
        if (!this.isNotFoundError(err as Error)) {
          const message = `team ${teamId}: ${(err as Error).message}`;
          errors.push(message);
          this.logger.warn(`Failed to delete Bifrost ${message}`);
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(`Bifrost teardown incomplete: ${errors.join('; ')}`);
    }
  }

  private isNotFoundError(err: Error): boolean {
    return err.message.includes('(404)');
  }

  async hasKeyedOpenAiProvider(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      const data = await this.request<{ keys?: Array<{ value?: { value?: string }; enabled?: boolean }> }>(
        'GET',
        '/api/providers/openai/keys'
      );
      return (data.keys ?? []).some((key) => key.enabled !== false && (key.value?.value ?? '') !== '');
    } catch (err) {
      if (err instanceof Error && this.isNotFoundError(err)) return false;
      throw err;
    }
  }

  async listProviders(): Promise<BifrostProviderSummary[]> {
    const data = await this.request<{ providers?: BifrostProviderResponse[] }>('GET', '/api/providers');
    return (data.providers ?? []).map(providerSummaryOf);
  }

  async findProvider(provider: string): Promise<BifrostProviderSummary | null> {
    try {
      return providerSummaryOf(
        await this.request<BifrostProviderResponse>('GET', `/api/providers/${encodeURIComponent(provider)}`)
      );
    } catch (err) {
      if (err instanceof BifrostApiError && err.status === 404) return null;
      throw err;
    }
  }

  async updateProvider(provider: string, payload: UpdateBifrostProviderRequest): Promise<void> {
    await this.request('PUT', `/api/providers/${encodeURIComponent(provider)}`, payload);
  }

  async listProviderKeys(provider: string): Promise<BifrostProviderKeySummary[]> {
    const data = await this.request<{ keys?: BifrostProviderKeySummary[] }>(
      'GET',
      `/api/providers/${encodeURIComponent(provider)}/keys`
    );
    return data.keys ?? [];
  }

  async replaceProviderKey(
    provider: string,
    keyId: string,
    key: CreateBifrostProviderKeyRequest | BifrostProviderKeySummary
  ): Promise<void> {
    await this.request('PUT', `/api/providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(keyId)}`, key);
  }

  async createProvider(payload: CreateBifrostProviderRequest): Promise<void> {
    await this.request('POST', '/api/providers', payload);
  }

  async addProviderKey(provider: string, key: CreateBifrostProviderKeyRequest): Promise<void> {
    await this.request('POST', `/api/providers/${encodeURIComponent(provider)}/keys`, key);
  }

  async hasProvider(provider: string): Promise<boolean> {
    return (await this.findProvider(provider)) !== null;
  }

  async deleteProviderConfirmed(provider: string): Promise<void> {
    try {
      await this.request('DELETE', `/api/providers/${encodeURIComponent(provider)}`);
    } catch (err) {
      if (!(err instanceof BifrostApiError && err.status === 404)) throw err;
    }
    if (await this.hasProvider(provider)) {
      throw new Error(`Bifrost answered the delete of provider ${provider} but still has it`);
    }
  }

  async setVirtualKeyProviderConfigs(keyId: string, providerConfigs: BifrostProviderConfig[]): Promise<void> {
    await this.request('PUT', `/api/governance/virtual-keys/${keyId}`, { provider_configs: providerConfigs });
  }

  async getTeamBudget(teamId: string): Promise<BifrostBudget | null> {
    const data = await this.request<{ team: { budgets?: BifrostBudget[] } }>('GET', `/api/governance/teams/${teamId}`);
    return data.team.budgets?.[0] ?? null;
  }

  async createProjectKey(
    projectId: string,
    tenantId: string | null,
    budgets: BudgetDefaults,
    keyType: KeyType = 'chat',
    teamId?: string
  ): Promise<{ keyId: string; keyToken: string }> {
    const [existing] = await db
      .select()
      .from(projectVirtualKeys)
      .where(
        and(
          eq(projectVirtualKeys.projectId, projectId),
          eq(projectVirtualKeys.keyType, keyType),
          eq(projectVirtualKeys.status, 'active')
        )
      );

    if (existing) {
      return { keyId: existing.bifrostKeyId, keyToken: existing.bifrostKeyToken };
    }

    const payload: CreateVirtualKeyRequest = {
      name: `project-${projectId.slice(0, 8)}-${keyType}`,
      description: `Virtual key (${keyType}) for project ${projectId}${tenantId ? ` (tenant: ${tenantId})` : ' (pool)'}`,
      provider_configs: keyType === 'backend' ? BACKEND_PROVIDER_CONFIGS : [],
      budgets: [this.budgetFor(budgets, keyType)],
      ...(teamId ? { team_id: teamId } : {}),
    };

    const result = await this.request<CreateVirtualKeyResponse>('POST', '/api/governance/virtual-keys', payload);

    const keyId = result.virtual_key.id;
    const keyToken = result.virtual_key.value;

    await db.insert(projectVirtualKeys).values({
      id: crypto.randomUUID(),
      projectId,
      tenantId,
      keyType,
      bifrostKeyId: keyId,
      bifrostKeyToken: keyToken,
      status: 'active',
    });

    this.logger.log(`Created Bifrost virtual key (${keyType}) for project ${projectId}`);
    return { keyId, keyToken };
  }

  private async ensureProjectTeam(projectId: string, budgets: BudgetDefaults, customerId?: string): Promise<string> {
    const [project] = await db
      .select({ teamId: projects.bifrostProjectId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (project?.teamId) return project.teamId;

    return this.createProjectTeam(projectId, budgets, customerId);
  }

  async createProjectResources(params: { projectId: string; tenantId: string }): Promise<void> {
    const { projectId, tenantId } = params;

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) return;

    const budgets = await this.defaultsService.getTenantBudgets(tenantId);
    const customerId = tenant.bifrostTenantId ?? (await this.createTenantCustomer(tenantId, tenant.name, budgets));

    const teamId = await this.ensureProjectTeam(projectId, budgets, customerId);

    await Promise.all([
      this.createProjectKey(projectId, tenantId, budgets, 'chat', teamId),
      this.createProjectKey(projectId, tenantId, budgets, 'backend', teamId),
    ]);
  }

  async createOrphanProjectResources(params: { projectId: string }): Promise<void> {
    const { projectId } = params;

    const budgets = await this.defaultsService.getGlobalBudgets();
    const teamId = await this.ensureProjectTeam(projectId, budgets);

    await Promise.all([
      this.createProjectKey(projectId, null, budgets, 'chat', teamId),
      this.createProjectKey(projectId, null, budgets, 'backend', teamId),
    ]);
  }

  async getEnvironmentPodOptions(
    projectEnvironmentId: string
  ): Promise<{ bifrostApiKey: string; bifrostBackendApiKey?: string; bifrostProxyUrl: string } | null> {
    const [env] = await db
      .select({ projectId: projectEnvironments.projectId })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!env) return null;

    const keys = await db
      .select()
      .from(projectVirtualKeys)
      .where(and(eq(projectVirtualKeys.projectId, env.projectId), eq(projectVirtualKeys.status, 'active')));

    const pick = (keyType: KeyType) =>
      keys.find((k) => k.keyType === keyType && k.projectEnvironmentId === projectEnvironmentId) ??
      keys.find((k) => k.keyType === keyType);

    const chatKey = pick('chat');
    const backendKey = pick('backend');
    if (!chatKey || !backendKey) return null;

    return {
      bifrostApiKey: chatKey.bifrostKeyToken,
      bifrostBackendApiKey: backendKey.bifrostKeyToken,
      bifrostProxyUrl: this.podProxyUrl,
    };
  }

  async getProjectChatKeyToken(projectId: string, projectEnvironmentId?: string): Promise<string | null> {
    const keys = await db
      .select()
      .from(projectVirtualKeys)
      .where(
        and(
          eq(projectVirtualKeys.projectId, projectId),
          eq(projectVirtualKeys.keyType, 'chat'),
          eq(projectVirtualKeys.status, 'active')
        )
      );

    const environmentKey = projectEnvironmentId
      ? keys.find((k) => k.projectEnvironmentId === projectEnvironmentId)
      : undefined;
    const projectKey = keys.find((k) => k.projectEnvironmentId === null);
    const key = environmentKey ?? projectKey ?? keys[0];
    return key?.bifrostKeyToken ?? null;
  }

  async getProjectKeyBudgets(projectId: string): Promise<Array<{ keyType: KeyType; budget: BifrostBudget | null }>> {
    const keys = await db
      .select()
      .from(projectVirtualKeys)
      .where(and(eq(projectVirtualKeys.projectId, projectId), eq(projectVirtualKeys.status, 'active')));

    return Promise.all(
      keys.map(async (k) => {
        const data = await this.request<{ virtual_key: { budgets?: BifrostBudget[] } }>(
          'GET',
          `/api/governance/virtual-keys/${k.bifrostKeyId}`
        );
        const budget = data.virtual_key.budgets?.[0] ?? null;
        return { keyType: k.keyType as KeyType, budget };
      })
    );
  }

  async updateKeyBudget(projectId: string, keyType: KeyType, maxBudget: number, budgetDuration: string): Promise<void> {
    const [key] = await db
      .select()
      .from(projectVirtualKeys)
      .where(
        and(
          eq(projectVirtualKeys.projectId, projectId),
          eq(projectVirtualKeys.keyType, keyType),
          eq(projectVirtualKeys.status, 'active')
        )
      );

    if (!key) throw new Error(`No active ${keyType} key for project ${projectId}`);

    const [project] = await db
      .select({ teamId: projects.bifrostProjectId })
      .from(projects)
      .where(eq(projects.id, projectId));

    const budget: BifrostBudget | undefined =
      maxBudget > 0 ? { max_limit: maxBudget, reset_duration: budgetDuration } : undefined;

    await this.updateVirtualKey(key.bifrostKeyId, project?.teamId ?? null, budget);

    this.logger.log(`Updated budget for ${keyType} key of project ${projectId}: $${maxBudget}/${budgetDuration}`);
  }

  /** Clears the spend recorded against the Project's team and active keys, keeping every limit as it is. */
  async resetProjectSpend(projectId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const [project] = await db
      .select({ teamId: projects.bifrostProjectId })
      .from(projects)
      .where(eq(projects.id, projectId));
    const keys = await db
      .select({ bifrostKeyId: projectVirtualKeys.bifrostKeyId })
      .from(projectVirtualKeys)
      .where(and(eq(projectVirtualKeys.projectId, projectId), eq(projectVirtualKeys.status, 'active')));

    await Promise.all([
      ...(project?.teamId ? [this.resetUsage(`/api/governance/teams/${project.teamId}`, 'team')] : []),
      ...keys.map((key) => this.resetUsage(`/api/governance/virtual-keys/${key.bifrostKeyId}`, 'virtual_key')),
    ]);
    this.logger.log(`Reset the Bifrost spend of project ${projectId}`);
  }

  private async resetUsage(path: string, field: 'team' | 'virtual_key'): Promise<void> {
    const data = await this.request<Record<typeof field, { budgets?: BifrostBudget[] }>>('GET', path);
    const budgets = (data[field].budgets ?? []).map(({ max_limit, reset_duration }) => ({ max_limit, reset_duration }));
    if (budgets.length === 0) return;
    await this.request('PUT', path, { budgets, reset_budget_usage: true });
  }

  async revokeProjectKeys(projectId: string): Promise<void> {
    const activeKeys = await db
      .select()
      .from(projectVirtualKeys)
      .where(and(eq(projectVirtualKeys.projectId, projectId), eq(projectVirtualKeys.status, 'active')));

    await Promise.allSettled(
      activeKeys.map(async (key) => {
        try {
          await this.request<DeleteVirtualKeyResponse>('DELETE', `/api/governance/virtual-keys/${key.bifrostKeyId}`);
        } catch (err) {
          this.logger.warn(`Failed to delete Bifrost key ${key.bifrostKeyId}: ${(err as Error).message}`);
        }
        await db
          .update(projectVirtualKeys)
          .set({ status: 'revoked', updatedAt: new Date() })
          .where(eq(projectVirtualKeys.id, key.id));
      })
    );

    if (activeKeys.length > 0) {
      this.logger.log(`Revoked ${activeKeys.length} Bifrost virtual key(s) for project ${projectId}`);
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (project?.bifrostProjectId) {
      try {
        await this.deleteTeam(project.bifrostProjectId);
        await db.update(projects).set({ bifrostProjectId: null }).where(eq(projects.id, projectId));
      } catch (err) {
        this.logger.warn(`Failed to delete Bifrost team for project ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  async revokeEnvironmentKeys(projectEnvironmentId: string): Promise<void> {
    const activeKeys = await db
      .select()
      .from(projectVirtualKeys)
      .where(
        and(eq(projectVirtualKeys.projectEnvironmentId, projectEnvironmentId), eq(projectVirtualKeys.status, 'active'))
      );

    await Promise.allSettled(
      activeKeys.map(async (key) => {
        try {
          await this.request<DeleteVirtualKeyResponse>('DELETE', `/api/governance/virtual-keys/${key.bifrostKeyId}`);
        } catch (err) {
          this.logger.warn(`Failed to delete Bifrost key ${key.bifrostKeyId}: ${(err as Error).message}`);
        }
        await db
          .update(projectVirtualKeys)
          .set({ status: 'revoked', updatedAt: new Date() })
          .where(eq(projectVirtualKeys.id, key.id));
      })
    );

    if (activeKeys.length > 0) {
      this.logger.log(`Revoked ${activeKeys.length} Bifrost virtual key(s) for environment ${projectEnvironmentId}`);
    }
  }
}

import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { linkedAccounts, modelProviders, projectVirtualKeys, projects, tenants } from '../../db/schema';
import { BifrostService } from '../bifrost/bifrost.service';
import { retryBifrostWrite } from '../bifrost/bifrost-retries';
import type { BifrostProviderConfig, BifrostProviderSummary } from '../bifrost/bifrost.types';
import { lockPlatformModelProvidersShared, lockTenantModelProviders, type DbExecutor } from '../common/locks';
import type { TenantContext } from '../tenant/tenant.decorator';
import { agentsAffected, agentsUsingFormat } from './affected-agents';
import { BASE_FORMAT_IDS, isBaseFormatId, type BaseFormatId } from './base-formats';
import { isServedByLinkedAccountProxy, kindOf } from './bifrost-provider-shape';
import {
  BIFROST_UNREACHABLE_MESSAGE,
  MAX_WEIGHT,
  MIN_WEIGHT,
  WEIGHT_RULE_MESSAGE,
  type ModelProviderStatus,
  type ModelProviderSwitch,
  type TenantModelProviderView,
  type TenantModelProvidersView,
} from './model-provider.types';

const CHAT_KEY_WRITES_IN_FLIGHT = 8;
const TENANT_ROW_ID = sql.raw('"model_providers"."id"');
const TENANT_ROW_BIFROST_PROVIDER = sql.raw('"model_providers"."bifrost_provider"');

export interface ChatKeyScope {
  projectId: string;
}

export type BifrostProvidersByName = Map<string, BifrostProviderSummary>;

export interface LinkedAccountSignIn {
  linkedAccountConnected: boolean;
  linkedAccountNeedsSignIn: boolean;
}

interface EffectiveRow extends LinkedAccountSignIn {
  id: string;
  bifrostProvider: string;
  enabled: boolean;
  weight: number;
  ownsLinkedAccount: boolean;
}

const NOT_SIGNED_IN: LinkedAccountSignIn = { linkedAccountConnected: false, linkedAccountNeedsSignIn: false };
const IN_TRAFFIC: ReadonlySet<ModelProviderStatus> = new Set(['working', 'failing']);

export function baseFormatOf(provider: BifrostProviderSummary | undefined): BaseFormatId | null {
  if (!provider) return null;
  const type = provider.baseProviderType ?? provider.name;
  return isBaseFormatId(type) ? type : null;
}

export function statusOf(
  providers: BifrostProvidersByName | null,
  bifrostProvider: string,
  linkedAccountProxyUrl: string,
  signIn: LinkedAccountSignIn = NOT_SIGNED_IN
): ModelProviderStatus {
  if (!providers) return 'unknown';
  const provider = providers.get(bifrostProvider);
  if (!provider) return 'missing';
  if (isServedByLinkedAccountProxy(provider, linkedAccountProxyUrl) && !signIn.linkedAccountConnected) {
    return signIn.linkedAccountNeedsSignIn ? 'needs-sign-in' : 'not-signed-in';
  }
  return provider.status === 'error' ? 'failing' : 'working';
}

function displayNameOf(tenant: TenantContext, bifrostProvider: string, platformNames: Set<string>): string {
  const customPrefix = `${tenant.tenantName}-`;
  if (platformNames.has(bifrostProvider) || !bifrostProvider.startsWith(customPrefix)) return bifrostProvider;
  return bifrostProvider.slice(customPrefix.length);
}

function isWeight(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_WEIGHT && (value as number) <= MAX_WEIGHT;
}

function parseSwitches(input: unknown): ModelProviderSwitch[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestException('providers must be a non-empty list');
  }
  const seen = new Set<string>();
  return input.map((entry: Partial<ModelProviderSwitch> | null) => {
    if (typeof entry?.name !== 'string' || typeof entry.enabled !== 'boolean') {
      throw new BadRequestException('Each provider needs a name and an on/off switch');
    }
    if (!isWeight(entry.weight)) {
      throw new BadRequestException(`A weight is a whole number from ${MIN_WEIGHT} to ${MAX_WEIGHT}`);
    }
    if (seen.has(entry.name)) throw new BadRequestException(`${entry.name} is listed twice`);
    seen.add(entry.name);
    return { name: entry.name, enabled: entry.enabled, weight: entry.weight };
  });
}

interface ProviderSwitch {
  enabled: boolean;
  weight: number;
}

function sameSwitch(a: ProviderSwitch, b: ProviderSwitch): boolean {
  return a.enabled === b.enabled && a.weight === b.weight;
}

@Injectable()
export class ModelProvidersService {
  private readonly logger = new Logger(ModelProvidersService.name);
  private readonly linkedAccountProxyUrl: string;

  constructor(
    private readonly bifrostService: BifrostService,
    configService: ConfigService
  ) {
    this.linkedAccountProxyUrl = configService.getOrThrow<string>('linkedAccountProxyUrl');
  }

  async lockAndRewriteTenantChatKeys(tenantId: string, scope?: ChatKeyScope): Promise<void> {
    if (!this.bifrostService.isEnabled()) return;

    await db.transaction(async (tx) => {
      await lockTenantModelProviders(tx, tenantId);
      await this.writeChatKeys(tx, tenantId, scope);
    });
  }

  async listTenantProviders(tenant: TenantContext): Promise<TenantModelProvidersView> {
    const providers = await this.bifrostProvidersOrNull();
    const [rows, platformNames] = await Promise.all([
      this.effectiveRows(db, tenant.tenantId),
      this.platformProviderNames(),
    ]);
    return {
      bifrostReachable: providers !== null,
      baseFormats: BASE_FORMAT_IDS,
      providers: rows.map((row): TenantModelProviderView => {
        const view: TenantModelProviderView = {
          name: displayNameOf(tenant, row.bifrostProvider, platformNames),
          baseFormat: baseFormatOf(providers?.get(row.bifrostProvider)),
          enabled: row.enabled,
          weight: row.weight,
          status: statusOf(providers, row.bifrostProvider, this.linkedAccountProxyUrl, row),
        };
        if (!platformNames.has(row.bifrostProvider)) {
          const provider = providers?.get(row.bifrostProvider);
          view.kind = row.ownsLinkedAccount ? 'linked-account' : kindOf(provider, this.linkedAccountProxyUrl);
          if (view.kind === 'compatible-endpoint' && provider?.baseUrl) view.baseUrl = provider.baseUrl;
        }
        return view;
      }),
    };
  }

  async saveBaseFormat(
    tenant: TenantContext,
    format: string,
    input: unknown,
    acknowledgeAffectedAgents = false
  ): Promise<TenantModelProvidersView> {
    if (!isBaseFormatId(format)) throw new BadRequestException(`Unknown Base format: ${format}`);
    const switches = parseSwitches(input);
    const providers = await this.bifrostProvidersOrNull();
    if (!providers) throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
    const platformNames = await this.platformProviderNames();

    await db.transaction(async (tx) => {
      await lockPlatformModelProvidersShared(tx);
      await lockTenantModelProviders(tx, tenant.tenantId);
      const formatRows = (await this.effectiveRows(tx, tenant.tenantId)).filter(
        (row) => baseFormatOf(providers.get(row.bifrostProvider)) === format
      );
      const rowByName = new Map(
        formatRows.map((row) => [displayNameOf(tenant, row.bifrostProvider, platformNames), row])
      );

      const changed = switches.map((change) => {
        const row = rowByName.get(change.name);
        if (!row)
          throw new BadRequestException(`${change.name} is not a ${format} model provider of this organization`);
        return { id: row.id, bifrostProvider: row.bifrostProvider, enabled: change.enabled, weight: change.weight };
      });
      const changedById = new Map(changed.map((row) => [row.id, row]));
      const rowsAfter = formatRows.map((row) => Object.assign(row, changedById.get(row.id)));
      const enabledAfter = rowsAfter.filter((row) => row.enabled);
      if (enabledAfter.length > 0 && enabledAfter.every((row) => row.weight === 0)) {
        throw new BadRequestException(WEIGHT_RULE_MESSAGE);
      }
      if (this.reachableRows(rowsAfter, providers).length === 0 && !acknowledgeAffectedAgents) {
        const affected = await agentsUsingFormat(tx, tenant.tenantId, format);
        if (affected.length > 0) throw agentsAffected(format, affected);
      }

      const platformDefaults = await this.platformDefaults(tx);
      for (const row of changed) {
        const platformDefault = platformDefaults.get(row.bifrostProvider);
        if (platformDefault) {
          await this.writePlatformOverride(tx, tenant.tenantId, row.bifrostProvider, row, platformDefault);
          continue;
        }
        await tx
          .update(modelProviders)
          .set({ enabled: row.enabled, weight: row.weight })
          .where(eq(modelProviders.id, row.id));
      }
      await this.writeChatKeys(tx, tenant.tenantId, undefined, providers);
    });

    return this.listTenantProviders(tenant);
  }

  async rewriteTenantChatKeys(tx: DbExecutor, tenantId: string): Promise<void> {
    await this.writeChatKeys(tx, tenantId);
  }

  async rewriteChatKeysOfTenantsUsing(tx: DbExecutor, bifrostProvider: string): Promise<void> {
    for (const tenantId of await this.tenantIdsUsing(tx, bifrostProvider)) {
      await lockTenantModelProviders(tx, tenantId);
      await this.writeChatKeys(tx, tenantId);
    }
  }

  async tenantIdsUsing(executor: DbExecutor, bifrostProvider: string): Promise<string[]> {
    if ((await this.platformProviderNames(executor)).has(bifrostProvider)) {
      const everyTenant = await executor.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id));
      return everyTenant.map((tenant) => tenant.id);
    }
    const rows = await executor
      .select({ tenantId: modelProviders.tenantId })
      .from(modelProviders)
      .where(and(eq(modelProviders.bifrostProvider, bifrostProvider), isNotNull(modelProviders.tenantId)))
      .orderBy(asc(modelProviders.tenantId));
    return rows.flatMap((row) => (row.tenantId ? [row.tenantId] : []));
  }

  async reachableBaseFormats(tenantId: string): Promise<BaseFormatId[]> {
    const providers = await this.bifrostProvidersOrNull();
    if (!providers) return BASE_FORMAT_IDS;
    const reachable = this.reachableRows(await this.effectiveRows(db, tenantId), providers);
    const formats = new Set(reachable.map((row) => baseFormatOf(providers.get(row.bifrostProvider))));
    return BASE_FORMAT_IDS.filter((format) => formats.has(format));
  }

  async isProviderReachable(tenantId: string, bifrostProvider: string): Promise<boolean> {
    const providers = await this.bifrostProvidersOrNull();
    const rows = (await this.effectiveRows(db, tenantId)).filter((row) => row.bifrostProvider === bifrostProvider);
    return providers ? this.reachableRows(rows, providers).length > 0 : rows.some((row) => row.enabled);
  }

  async restoreTenantChatKeys(tenantIds: string[]): Promise<void> {
    for (const tenantId of tenantIds) {
      try {
        await this.lockAndRewriteTenantChatKeys(tenantId);
      } catch (err) {
        this.logger.error(`Chat keys of tenant ${tenantId} were not restored: ${(err as Error).message}`);
      }
    }
  }

  async writeProjectChatKey(tenantId: string, projectId: string): Promise<boolean> {
    return retryBifrostWrite(this.logger, `Chat key write (project=${projectId})`, () =>
      this.lockAndRewriteTenantChatKeys(tenantId, { projectId })
    );
  }

  private async writeChatKeys(
    tx: DbExecutor,
    tenantId: string,
    scope?: ChatKeyScope,
    providers?: BifrostProvidersByName
  ): Promise<void> {
    const providerConfigs = await this.chatKeyProviderConfigs(tx, tenantId, providers);
    const keyIds = await this.chatKeyIds(tx, tenantId, scope);
    for (let start = 0; start < keyIds.length; start += CHAT_KEY_WRITES_IN_FLIGHT) {
      await Promise.all(
        keyIds
          .slice(start, start + CHAT_KEY_WRITES_IN_FLIGHT)
          .map((keyId) => this.bifrostService.setVirtualKeyProviderConfigs(keyId, providerConfigs))
      );
    }
  }

  private async chatKeyProviderConfigs(
    tx: DbExecutor,
    tenantId: string,
    providers?: BifrostProvidersByName
  ): Promise<BifrostProviderConfig[]> {
    const rows = (await this.effectiveRows(tx, tenantId)).filter((row) => row.enabled);
    if (rows.length === 0) return [];

    const inBifrost = providers ?? (await this.bifrostProviders());
    return this.reachableRows(rows, inBifrost).map((row) => ({
      provider: row.bifrostProvider,
      weight: row.weight,
      allowed_models: ['*'],
      key_ids: ['*'],
    }));
  }

  private reachableRows(rows: EffectiveRow[], providers: BifrostProvidersByName): EffectiveRow[] {
    return rows.filter(
      (row) => row.enabled && IN_TRAFFIC.has(statusOf(providers, row.bifrostProvider, this.linkedAccountProxyUrl, row))
    );
  }

  private effectiveRows(executor: DbExecutor, tenantId: string): Promise<EffectiveRow[]> {
    return executor
      .select({
        id: modelProviders.id,
        bifrostProvider: modelProviders.bifrostProvider,
        enabled: modelProviders.enabled,
        weight: modelProviders.weight,
        linkedAccountConnected: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account
          join model_providers owner on owner.id = account.model_provider_id
          where owner.bifrost_provider = ${TENANT_ROW_BIFROST_PROVIDER}
            and (owner.tenant_id is null or owner.id = ${TENANT_ROW_ID})
            and account.credential is not null
        )`,
        linkedAccountNeedsSignIn: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account
          join model_providers owner on owner.id = account.model_provider_id
          where owner.bifrost_provider = ${TENANT_ROW_BIFROST_PROVIDER}
            and (owner.tenant_id is null or owner.id = ${TENANT_ROW_ID})
            and account.credential is null
            and account.status_reason is not null
        )`,
        ownsLinkedAccount: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account where account.model_provider_id = ${TENANT_ROW_ID}
        )`,
      })
      .from(modelProviders)
      .where(
        sql`${modelProviders.tenantId} = ${tenantId} or (${modelProviders.tenantId} is null and not exists (
          select 1 from model_providers override
          where override.tenant_id = ${tenantId} and override.bifrost_provider = ${TENANT_ROW_BIFROST_PROVIDER}
        ))`
      )
      .orderBy(asc(modelProviders.bifrostProvider));
  }

  private async writePlatformOverride(
    tx: DbExecutor,
    tenantId: string,
    bifrostProvider: string,
    choice: ProviderSwitch,
    platformDefault: ProviderSwitch
  ): Promise<void> {
    if (sameSwitch(choice, platformDefault)) {
      await tx
        .delete(modelProviders)
        .where(and(eq(modelProviders.tenantId, tenantId), eq(modelProviders.bifrostProvider, bifrostProvider)));
      return;
    }
    await tx
      .insert(modelProviders)
      .values({ tenantId, bifrostProvider, enabled: choice.enabled, weight: choice.weight })
      .onConflictDoUpdate({
        target: [modelProviders.tenantId, modelProviders.bifrostProvider],
        set: { enabled: choice.enabled, weight: choice.weight },
      });
  }

  private async platformDefaults(executor: DbExecutor): Promise<Map<string, ProviderSwitch>> {
    const rows = await executor
      .select({
        bifrostProvider: modelProviders.bifrostProvider,
        enabled: modelProviders.enabled,
        weight: modelProviders.weight,
      })
      .from(modelProviders)
      .where(isNull(modelProviders.tenantId));
    return new Map(rows.map(({ bifrostProvider, ...choice }) => [bifrostProvider, choice]));
  }

  async platformLinkedAccountSignIns(): Promise<Map<string, LinkedAccountSignIn>> {
    const rows = await db
      .select({
        bifrostProvider: modelProviders.bifrostProvider,
        linkedAccountConnected: sql<boolean>`${linkedAccounts.credential} is not null`,
        linkedAccountNeedsSignIn: sql<boolean>`${linkedAccounts.credential} is null and ${linkedAccounts.statusReason} is not null`,
      })
      .from(linkedAccounts)
      .innerJoin(modelProviders, eq(modelProviders.id, linkedAccounts.modelProviderId))
      .where(isNull(modelProviders.tenantId));
    return new Map(rows.map(({ bifrostProvider, ...signIn }) => [bifrostProvider, signIn]));
  }

  async platformProviderNames(executor: DbExecutor = db): Promise<Set<string>> {
    const rows = await executor
      .select({ bifrostProvider: modelProviders.bifrostProvider })
      .from(modelProviders)
      .where(isNull(modelProviders.tenantId));
    return new Set(rows.map((row) => row.bifrostProvider));
  }

  private async bifrostProviders(): Promise<BifrostProvidersByName> {
    const providers = await this.bifrostService.listProviders();
    return new Map(providers.map((provider) => [provider.name, provider]));
  }

  async bifrostProvidersOrNull(): Promise<BifrostProvidersByName | null> {
    if (!this.bifrostService.isEnabled()) return null;
    try {
      return await this.bifrostProviders();
    } catch (err) {
      this.logger.warn(`Bifrost's provider list could not be read: ${(err as Error).message}`);
      return null;
    }
  }

  private async chatKeyIds(tx: DbExecutor, tenantId: string, scope?: ChatKeyScope): Promise<string[]> {
    const keys = await tx
      .select({ bifrostKeyId: projectVirtualKeys.bifrostKeyId })
      .from(projectVirtualKeys)
      .innerJoin(projects, eq(projects.id, projectVirtualKeys.projectId))
      .where(
        and(
          eq(projects.tenantId, tenantId),
          eq(projectVirtualKeys.keyType, 'chat'),
          eq(projectVirtualKeys.status, 'active'),
          ...(scope ? [eq(projects.id, scope.projectId)] : [])
        )
      );
    return keys.map((key) => key.bifrostKeyId);
  }
}

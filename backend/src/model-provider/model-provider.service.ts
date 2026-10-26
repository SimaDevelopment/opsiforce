import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  keyTypeEnum,
  linkedAccounts,
  modelProviderAvailability,
  modelProviderAvailabilityTenants,
  modelProviders,
  projectVirtualKeys,
  projects,
  tenants,
} from '../../db/schema';
import { BifrostService } from '../bifrost/bifrost.service';
import { retryBifrostWrite } from '../bifrost/bifrost-retries';
import type {
  BifrostProviderConfig,
  BifrostProviderKeySummary,
  BifrostProviderSummary,
} from '../bifrost/bifrost.types';
import { lockPlatformModelProvidersShared, lockTenantModelProviders, type DbExecutor } from '../common/locks';
import type { TenantContext } from '../tenant/tenant.decorator';
import { agentsAffected, agentsUsingFormat } from './affected-agents';
import { BASE_FORMATS, BASE_FORMAT_IDS, isBaseFormatId, type BaseFormatId } from './base-formats';
import { isServedByLinkedAccountProxy, kindOf, servedModelsOf } from './bifrost-provider-shape';
import { deploymentsOf, endpointOf, familyModels, keyModelsOf, servesEveryModel } from './key-model-formats';
import {
  BIFROST_UNREACHABLE_MESSAGE,
  APP_WEIGHT_RULE_MESSAGE,
  MAX_WEIGHT,
  MIN_WEIGHT,
  WEIGHT_RULE_MESSAGE,
  type AvailabilityMode,
  type ModelProviderStatus,
  type ModelProviderSwitch,
  type TenantModelProviderView,
  type TenantModelProvidersView,
} from './model-provider.types';

const KEY_WRITES_IN_FLIGHT = 8;
const ROW_ID = sql.raw('"model_providers"."id"');
const ROW_BIFROST_PROVIDER = sql.raw('"model_providers"."bifrost_provider"');
const ROW_BIFROST_KEY = sql.raw('"model_providers"."bifrost_key"');
const ROW_BASE_FORMAT = sql.raw('"model_providers"."base_format"');
const ROW_NAME = sql.raw('coalesce("model_providers"."bifrost_key", "model_providers"."bifrost_provider")');

export const AZURE_PROVIDER = 'azure';

export interface ProjectKeyScope {
  projectId: string;
}

export type BifrostProvidersByName = Map<string, BifrostProviderSummary>;

export type KeysByProvider = Map<string, BifrostProviderKeySummary[]>;

export interface LinkedAccountSignIn {
  linkedAccountConnected: boolean;
  linkedAccountNeedsSignIn: boolean;
}

export interface ProviderRowIdentity {
  bifrostProvider: string;
  bifrostKey: string | null;
  baseFormat: BaseFormatId | null;
}

interface EffectiveRow extends LinkedAccountSignIn, ProviderSwitch, ProviderRowIdentity {
  id: string;
  ownsLinkedAccount: boolean;
}

export interface Serving {
  models: string[] | null;
  keyIds: string[];
}

const EVERY_MODEL = ['*'];
const EVERY_KEY = ['*'];

type ProjectKeyType = (typeof keyTypeEnum.enumValues)[number];

interface ProjectKey {
  bifrostKeyId: string;
  keyType: ProjectKeyType;
}

const NOT_SIGNED_IN: LinkedAccountSignIn = { linkedAccountConnected: false, linkedAccountNeedsSignIn: false };
const IN_TRAFFIC: ReadonlySet<ModelProviderStatus> = new Set(['working', 'failing']);

export function baseFormatOf(provider: BifrostProviderSummary | undefined): BaseFormatId | null {
  if (!provider) return null;
  const type = provider.baseProviderType ?? provider.name;
  return isBaseFormatId(type) ? type : null;
}

export function nameOfRow(row: { bifrostProvider: string; bifrostKey: string | null }): string {
  return row.bifrostKey ?? row.bifrostProvider;
}

export function rowFormatOf(row: ProviderRowIdentity, providers: BifrostProvidersByName | null): BaseFormatId | null {
  return row.baseFormat ?? baseFormatOf(providers?.get(row.bifrostProvider));
}

export function readsKeyModels(provider: BifrostProviderSummary | undefined): boolean {
  return provider !== undefined && provider.baseProviderType !== null && !provider.listsModels;
}

export function connectionKeyOf(row: ProviderRowIdentity, keys: KeysByProvider): BifrostProviderKeySummary | undefined {
  if (!row.bifrostKey) return undefined;
  return keys.get(row.bifrostProvider)?.find((key) => key.name === row.bifrostKey);
}

export function servingOf(
  row: ProviderRowIdentity,
  providers: BifrostProvidersByName | null,
  keys: KeysByProvider
): Serving {
  const format = rowFormatOf(row, providers);
  if (row.bifrostKey) {
    const key = connectionKeyOf(row, keys);
    if (!key || !format) return { models: [], keyIds: [] };
    return { models: familyModels(keyModelsOf([key]), format), keyIds: [key.id] };
  }
  const provider = providers?.get(row.bifrostProvider);
  if (!format) return { models: null, keyIds: EVERY_KEY };
  const wholeCatalog = readsKeyModels(provider)
    ? [...servedModelsOf(BASE_FORMATS[format]), ...(provider?.servesImages ? BASE_FORMATS[format].imageModels : [])]
    : null;
  const providerKeys = keys.get(row.bifrostProvider);
  if (!providerKeys || provider?.keyLess) return { models: wholeCatalog, keyIds: EVERY_KEY };
  const keyModels = keyModelsOf(providerKeys);
  if (keyModels.length === 0 || servesEveryModel(keyModels)) return { models: wholeCatalog, keyIds: EVERY_KEY };
  if (!readsKeyModels(provider)) return { models: keyModels, keyIds: EVERY_KEY };
  return { models: familyModels(keyModels, format), keyIds: EVERY_KEY };
}

export function servedSubsetOf(row: ProviderRowIdentity, serving: Serving, providers: BifrostProvidersByName | null) {
  const format = rowFormatOf(row, providers);
  if (!serving.models || !format) return undefined;
  const catalog = servedModelsOf(BASE_FORMATS[format]);
  const servedFromCatalog = serving.models.filter((model) => catalog.includes(model));
  return catalog.every((model) => servedFromCatalog.includes(model)) ? undefined : servedFromCatalog;
}

export function providersReadForKeys(rows: ProviderRowIdentity[], providers: BifrostProvidersByName | null): string[] {
  return [...new Set(rows.filter((row) => providers?.has(row.bifrostProvider)).map((row) => row.bifrostProvider))];
}

function modelRefOf(format: BaseFormatId, model: string): string {
  return `${BASE_FORMATS[format].modelCatalogKey}/${model}`;
}

function catalogModelRefsOf(format: BaseFormatId): string[] {
  return servedModelsOf(BASE_FORMATS[format]).map((model) => modelRefOf(format, model));
}

function overrideKey(row: ProviderRowIdentity): string {
  return [row.bifrostProvider, row.bifrostKey ?? '', row.baseFormat ?? ''].join('\u0000');
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

export function rowStatusOf(
  row: ProviderRowIdentity,
  providers: BifrostProvidersByName | null,
  keys: KeysByProvider,
  linkedAccountProxyUrl: string,
  signIn: LinkedAccountSignIn = NOT_SIGNED_IN
): ModelProviderStatus {
  const status = statusOf(providers, row.bifrostProvider, linkedAccountProxyUrl, signIn);
  if (!row.bifrostKey || !IN_TRAFFIC.has(status) || !keys.has(row.bifrostProvider)) return status;
  return connectionKeyOf(row, keys) ? status : 'missing';
}

function displayNameOf(tenant: TenantContext, name: string, platformNames: Set<string>): string {
  const customPrefix = `${tenant.tenantName}-`;
  if (platformNames.has(name) || !name.startsWith(customPrefix)) return name;
  return name.slice(customPrefix.length);
}

function isWeight(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_WEIGHT && (value as number) <= MAX_WEIGHT;
}

function parseWeight(value: unknown): number {
  if (!isWeight(value)) throw new BadRequestException(`A weight is a whole number from ${MIN_WEIGHT} to ${MAX_WEIGHT}`);
  return value;
}

const SWITCHES = ['chatEnabled', 'backendEnabled'] as const;
const WEIGHTS = ['chatWeight', 'backendWeight'] as const;

function parseChange(entry: Partial<ModelProviderSwitch>): Partial<ProviderSwitch> {
  const change: Partial<ProviderSwitch> = {};
  for (const field of SWITCHES) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be true or false`);
    change[field] = value;
  }
  for (const field of WEIGHTS) {
    if (entry[field] !== undefined) change[field] = parseWeight(entry[field]);
  }
  return change;
}

function violatesWeightRule(rows: { enabled: boolean; weight: number }[]): boolean {
  const enabled = rows.filter((row) => row.enabled);
  return enabled.length > 0 && enabled.every((row) => row.weight === 0);
}

function parseSwitches(input: unknown): { name: string; changes: Partial<ProviderSwitch> }[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestException('providers must be a non-empty list');
  }
  const seen = new Set<string>();
  return input.map((entry: Partial<ModelProviderSwitch> | null) => {
    if (typeof entry?.name !== 'string') throw new BadRequestException('Each provider needs a name');
    if (seen.has(entry.name)) throw new BadRequestException(`${entry.name} is listed twice`);
    seen.add(entry.name);
    return { name: entry.name, changes: parseChange(entry) };
  });
}

interface ProviderSwitch {
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled: boolean;
  backendWeight: number;
}

function sameSwitch(a: ProviderSwitch, b: ProviderSwitch): boolean {
  return (
    a.chatEnabled === b.chatEnabled &&
    a.chatWeight === b.chatWeight &&
    a.backendEnabled === b.backendEnabled &&
    a.backendWeight === b.backendWeight
  );
}

function switchOf(row: ProviderSwitch): ProviderSwitch {
  return {
    chatEnabled: row.chatEnabled,
    chatWeight: row.chatWeight,
    backendEnabled: row.backendEnabled,
    backendWeight: row.backendWeight,
  };
}

export interface Availability {
  modes: Map<string, AvailabilityMode>;
  listed: Map<string, Set<string>>;
}

export function isAvailable(availability: Availability, name: string, tenantId: string): boolean {
  const chosen = availability.modes.get(name) === 'chosen';
  return chosen === (availability.listed.get(name)?.has(tenantId) ?? false);
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

  async lockAndRewriteTenantKeys(tenantId: string, scope?: ProjectKeyScope): Promise<void> {
    if (!this.bifrostService.isEnabled()) return;

    await db.transaction(async (tx) => {
      await lockTenantModelProviders(tx, tenantId);
      await this.writeTenantKeys(tx, tenantId, scope);
    });
  }

  async listTenantProviders(tenant: TenantContext): Promise<TenantModelProvidersView> {
    const providers = await this.bifrostProvidersOrNull();
    const [rows, platformNames] = await Promise.all([
      this.effectiveRows(db, tenant.tenantId),
      this.platformProviderNames(),
    ]);
    const keys = await this.keysOrEmpty(providersReadForKeys(rows, providers));
    return {
      bifrostReachable: providers !== null,
      baseFormats: BASE_FORMAT_IDS,
      catalogModels: Object.fromEntries(
        BASE_FORMAT_IDS.map((format) => [format, servedModelsOf(BASE_FORMATS[format])])
      ) as Record<BaseFormatId, string[]>,
      providers: rows.map((row): TenantModelProviderView => {
        const provider = providers?.get(row.bifrostProvider);
        const view: TenantModelProviderView = {
          name: displayNameOf(tenant, nameOfRow(row), platformNames),
          baseFormat: rowFormatOf(row, providers),
          ...switchOf(row),
          status: rowStatusOf(row, providers, keys, this.linkedAccountProxyUrl, row),
        };
        const servedModels = servedSubsetOf(row, servingOf(row, providers, keys), providers);
        if (servedModels) view.servedModels = servedModels;
        if (!platformNames.has(nameOfRow(row))) {
          if (row.bifrostKey) {
            view.kind = 'azure-foundry';
            const connectionKey = connectionKeyOf(row, keys);
            const endpoint = endpointOf(connectionKey);
            if (endpoint) view.baseUrl = endpoint;
            if (connectionKey) {
              view.connection = { models: keyModelsOf([connectionKey]), deployments: deploymentsOf(connectionKey) };
            }
          } else {
            view.kind = row.ownsLinkedAccount ? 'linked-account' : kindOf(provider, this.linkedAccountProxyUrl);
            if (view.kind === 'compatible-endpoint' && provider?.baseUrl) view.baseUrl = provider.baseUrl;
          }
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
        (row) => rowFormatOf(row, providers) === format
      );
      const rowByName = new Map(formatRows.map((row) => [displayNameOf(tenant, nameOfRow(row), platformNames), row]));

      const changed = switches.map((change): EffectiveRow => {
        const row = rowByName.get(change.name);
        if (!row)
          throw new BadRequestException(`${change.name} is not a ${format} model provider of this organization`);
        return { ...row, ...change.changes };
      });
      const changedById = new Map(changed.map((row) => [row.id, row]));
      const rowsAfter = formatRows.map((row) => changedById.get(row.id) ?? row);
      if (violatesWeightRule(rowsAfter.map((row) => ({ enabled: row.chatEnabled, weight: row.chatWeight })))) {
        throw new BadRequestException(WEIGHT_RULE_MESSAGE);
      }
      if (violatesWeightRule(rowsAfter.map((row) => ({ enabled: row.backendEnabled, weight: row.backendWeight })))) {
        throw new BadRequestException(APP_WEIGHT_RULE_MESSAGE);
      }
      if (!acknowledgeAffectedAgents) {
        const keys = await this.keys(providersReadForKeys(rowsAfter, providers));
        if (this.reachableRows(rowsAfter, providers, keys).length === 0) {
          const affected = await agentsUsingFormat(tx, tenant.tenantId, format);
          if (affected.length > 0) throw agentsAffected(format, affected);
        }
      }

      const platformDefaults = await this.platformDefaults(tx);
      for (const row of changed) {
        const platformDefault = platformDefaults.get(overrideKey(row));
        if (platformDefault) {
          await this.writePlatformOverride(tx, tenant.tenantId, row, switchOf(row), platformDefault);
          continue;
        }
        await tx.update(modelProviders).set(switchOf(row)).where(eq(modelProviders.id, row.id));
      }
      await this.writeTenantKeys(tx, tenant.tenantId, undefined, providers);
    });

    return this.listTenantProviders(tenant);
  }

  async availability(executor: DbExecutor = db): Promise<Availability> {
    const [modeRows, listedRows] = await Promise.all([
      executor.select().from(modelProviderAvailability),
      executor.select().from(modelProviderAvailabilityTenants),
    ]);
    const listed = new Map<string, Set<string>>();
    for (const row of listedRows) listed.set(row.name, (listed.get(row.name) ?? new Set()).add(row.tenantId));
    return { modes: new Map(modeRows.map((row) => [row.name, row.mode])), listed };
  }

  async setAvailableTo(tenantId: string, name: string, available: boolean): Promise<void> {
    const providers = await this.bifrostProvidersOrNull();
    if (!providers) throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);

    try {
      await this.writeAvailability(tenantId, name, available, providers);
    } catch (err) {
      await this.restoreTenantKeys([tenantId]);
      throw err;
    }
  }

  private async writeAvailability(
    tenantId: string,
    name: string,
    available: boolean,
    providers: BifrostProvidersByName
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await lockPlatformModelProvidersShared(tx);
      await lockTenantModelProviders(tx, tenantId);
      const [mode] = await tx
        .select({ mode: modelProviderAvailability.mode })
        .from(modelProviderAvailability)
        .where(eq(modelProviderAvailability.name, name));
      const listed = (mode?.mode === 'chosen') === available;
      if (listed) {
        await tx.insert(modelProviderAvailabilityTenants).values({ name, tenantId }).onConflictDoNothing();
      } else {
        await tx
          .delete(modelProviderAvailabilityTenants)
          .where(
            and(
              eq(modelProviderAvailabilityTenants.name, name),
              eq(modelProviderAvailabilityTenants.tenantId, tenantId)
            )
          );
      }
      await this.writeTenantKeys(tx, tenantId, undefined, providers);
    });
  }

  async setAvailabilityMode(executor: DbExecutor, name: string, mode: AvailabilityMode): Promise<void> {
    const availability = await this.availability(executor);
    if ((availability.modes.get(name) ?? 'every') === mode) return;
    const everyTenant = await executor.select({ id: tenants.id }).from(tenants);
    const availableTo = everyTenant.filter((tenant) => isAvailable(availability, name, tenant.id));
    const nowListed =
      mode === 'chosen'
        ? availableTo
        : everyTenant.filter((tenant) => !availableTo.some((available) => available.id === tenant.id));
    await executor.delete(modelProviderAvailabilityTenants).where(eq(modelProviderAvailabilityTenants.name, name));
    if (nowListed.length > 0) {
      await executor
        .insert(modelProviderAvailabilityTenants)
        .values(nowListed.map((tenant) => ({ name, tenantId: tenant.id })));
    }
    if (mode === 'every') {
      await executor.delete(modelProviderAvailability).where(eq(modelProviderAvailability.name, name));
    } else {
      await executor
        .insert(modelProviderAvailability)
        .values({ name, mode })
        .onConflictDoUpdate({ target: modelProviderAvailability.name, set: { mode } });
    }
  }

  async setInitialAvailability(executor: DbExecutor, name: string, chosenTenantIds: string[] | null): Promise<void> {
    if (!chosenTenantIds) return;
    await executor.insert(modelProviderAvailability).values({ name, mode: 'chosen' });
    if (chosenTenantIds.length > 0) {
      await executor
        .insert(modelProviderAvailabilityTenants)
        .values(chosenTenantIds.map((tenantId) => ({ name, tenantId })));
    }
  }

  async forgetAvailability(executor: DbExecutor, name: string): Promise<void> {
    await executor.delete(modelProviderAvailabilityTenants).where(eq(modelProviderAvailabilityTenants.name, name));
    await executor.delete(modelProviderAvailability).where(eq(modelProviderAvailability.name, name));
  }

  async rewriteKeysOfTenantsUsing(tx: DbExecutor, name: string): Promise<void> {
    for (const tenantId of await this.tenantIdsUsing(tx, name)) {
      await lockTenantModelProviders(tx, tenantId);
      await this.writeTenantKeys(tx, tenantId);
    }
  }

  async lockAndRewriteKeysOfTenantsUsing(name: string): Promise<void> {
    for (const tenantId of await this.tenantIdsUsing(db, name)) {
      await this.lockAndRewriteTenantKeys(tenantId);
    }
  }

  async tenantIdsUsing(executor: DbExecutor, name: string): Promise<string[]> {
    if ((await this.platformProviderNames(executor)).has(name)) {
      const everyTenant = await executor.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id));
      return everyTenant.map((tenant) => tenant.id);
    }
    const rows = await executor
      .selectDistinct({ tenantId: modelProviders.tenantId })
      .from(modelProviders)
      .where(sql`${ROW_NAME} = ${name} and ${modelProviders.tenantId} is not null`)
      .orderBy(asc(modelProviders.tenantId));
    return rows.flatMap((row) => (row.tenantId ? [row.tenantId] : []));
  }

  async reachableModels(tenantId: string): Promise<string[]> {
    const catalogRefs = BASE_FORMAT_IDS.flatMap(catalogModelRefsOf);
    const providers = await this.bifrostProvidersOrNull();
    if (!providers) return catalogRefs;
    const rows = await this.effectiveRows(db, tenantId);
    const keys = await this.keysOrNull(providersReadForKeys(rows, providers));
    if (!keys) return catalogRefs;
    const served = new Set<string>();
    for (const row of this.reachableRows(rows, providers, keys)) {
      const format = rowFormatOf(row, providers);
      if (!format) continue;
      const models = servingOf(row, providers, keys).models ?? servedModelsOf(BASE_FORMATS[format]);
      for (const model of models) served.add(modelRefOf(format, model));
    }
    return catalogRefs.filter((ref) => served.has(ref));
  }

  async isProviderReachable(tenantId: string, bifrostProvider: string): Promise<boolean> {
    const providers = await this.bifrostProvidersOrNull();
    const rows = (await this.effectiveRows(db, tenantId)).filter(
      (row) => row.bifrostProvider === bifrostProvider && !row.bifrostKey
    );
    return providers ? this.reachableRows(rows, providers, new Map()).length > 0 : rows.some((row) => row.chatEnabled);
  }

  async rewriteEveryTenantsKeys(): Promise<string[]> {
    const everyTenant = await db.select({ id: tenants.id }).from(tenants).orderBy(asc(tenants.id));
    const failed: string[] = [];
    for (const { id } of everyTenant) {
      try {
        await this.lockAndRewriteTenantKeys(id);
      } catch (err) {
        this.logger.error(`Keys of tenant ${id} were not rewritten: ${(err as Error).message}`);
        failed.push(id);
      }
    }
    return failed;
  }

  async pinEveryTenantsAzureEntries(): Promise<void> {
    const failed = await this.rewriteEveryTenantsKeys();
    if (failed.length > 0) {
      throw new ServiceUnavailableException(
        `The model gateway keys of ${failed.length} organizations couldn't be updated first, so the Azure connection wasn't added. Try again.`
      );
    }
  }

  async restoreTenantKeys(tenantIds: string[]): Promise<void> {
    for (const tenantId of tenantIds) {
      try {
        await this.lockAndRewriteTenantKeys(tenantId);
      } catch (err) {
        this.logger.error(`Keys of tenant ${tenantId} were not restored: ${(err as Error).message}`);
      }
    }
  }

  async writeProjectKeys(tenantId: string, projectId: string): Promise<boolean> {
    return retryBifrostWrite(this.logger, `Project key write (project=${projectId})`, () =>
      this.lockAndRewriteTenantKeys(tenantId, { projectId })
    );
  }

  async writeTenantKeys(
    tx: DbExecutor,
    tenantId: string,
    scope?: ProjectKeyScope,
    providers?: BifrostProvidersByName
  ): Promise<void> {
    const configsByType = await this.providerConfigsByKeyType(tx, tenantId, providers);
    const keys = await this.projectKeys(tx, tenantId, scope);
    for (let start = 0; start < keys.length; start += KEY_WRITES_IN_FLIGHT) {
      await Promise.all(
        keys
          .slice(start, start + KEY_WRITES_IN_FLIGHT)
          .map((key) => this.bifrostService.setVirtualKeyProviderConfigs(key.bifrostKeyId, configsByType[key.keyType]))
      );
    }
  }

  private async providerConfigsByKeyType(
    tx: DbExecutor,
    tenantId: string,
    providers?: BifrostProvidersByName
  ): Promise<Record<ProjectKeyType, BifrostProviderConfig[]>> {
    const rows = (await this.effectiveRows(tx, tenantId)).filter((row) => row.chatEnabled || row.backendEnabled);
    if (rows.length === 0) return { chat: [], backend: [] };

    const inBifrost = providers ?? (await this.bifrostProviders());
    const keys = await this.keys(providersReadForKeys(rows, inBifrost));
    const toConfigs = (picked: EffectiveRow[], weightOf: (row: EffectiveRow) => number): BifrostProviderConfig[] =>
      picked.flatMap((row) => {
        const serving = servingOf(row, inBifrost, keys);
        const allowedModels = serving.models ?? EVERY_MODEL;
        if (allowedModels.length === 0 || serving.keyIds.length === 0) return [];
        return [
          {
            provider: row.bifrostProvider,
            weight: weightOf(row),
            allowed_models: allowedModels,
            key_ids: serving.keyIds,
          },
        ];
      });
    return {
      chat: toConfigs(this.reachableRows(rows, inBifrost, keys), (row) => row.chatWeight),
      backend: toConfigs(this.reachableBackendRows(rows, inBifrost, keys), (row) => row.backendWeight),
    };
  }

  async keys(names: string[]): Promise<KeysByProvider> {
    const entries = await Promise.all(
      names.map(
        async (name): Promise<[string, BifrostProviderKeySummary[]]> => [
          name,
          await this.bifrostService.listProviderKeys(name),
        ]
      )
    );
    return new Map(entries);
  }

  async keysOrEmpty(names: string[]): Promise<KeysByProvider> {
    return (await this.keysOrNull(names)) ?? new Map();
  }

  async keysOrNull(names: string[]): Promise<KeysByProvider | null> {
    if (names.length === 0 || !this.bifrostService.isEnabled()) return new Map();
    try {
      return await this.keys(names);
    } catch (err) {
      this.logger.warn(`The model gateway's provider keys could not be read: ${(err as Error).message}`);
      return null;
    }
  }

  private reachableRows(rows: EffectiveRow[], providers: BifrostProvidersByName, keys: KeysByProvider): EffectiveRow[] {
    return rows.filter((row) => row.chatEnabled && this.inTraffic(row, providers, keys));
  }

  private reachableBackendRows(
    rows: EffectiveRow[],
    providers: BifrostProvidersByName,
    keys: KeysByProvider
  ): EffectiveRow[] {
    return rows.filter((row) => row.backendEnabled && this.inTraffic(row, providers, keys));
  }

  private inTraffic(row: EffectiveRow, providers: BifrostProvidersByName, keys: KeysByProvider): boolean {
    return IN_TRAFFIC.has(rowStatusOf(row, providers, keys, this.linkedAccountProxyUrl, row));
  }

  private effectiveRows(executor: DbExecutor, tenantId: string): Promise<EffectiveRow[]> {
    return executor
      .select({
        id: modelProviders.id,
        bifrostProvider: modelProviders.bifrostProvider,
        bifrostKey: modelProviders.bifrostKey,
        baseFormat: modelProviders.baseFormat,
        chatEnabled: modelProviders.chatEnabled,
        chatWeight: modelProviders.chatWeight,
        backendEnabled: modelProviders.backendEnabled,
        backendWeight: modelProviders.backendWeight,
        linkedAccountConnected: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account
          join model_providers owner on owner.id = account.model_provider_id
          where owner.bifrost_provider = ${ROW_BIFROST_PROVIDER}
            and (owner.tenant_id is null or owner.id = ${ROW_ID})
            and account.credential is not null
        )`,
        linkedAccountNeedsSignIn: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account
          join model_providers owner on owner.id = account.model_provider_id
          where owner.bifrost_provider = ${ROW_BIFROST_PROVIDER}
            and (owner.tenant_id is null or owner.id = ${ROW_ID})
            and account.credential is null
            and account.status_reason is not null
        )`,
        ownsLinkedAccount: sql<boolean>`exists (
          select 1 from ${linkedAccounts} account where account.model_provider_id = ${ROW_ID}
        )`,
      })
      .from(modelProviders)
      .where(
        sql`(${modelProviders.tenantId} = ${tenantId} or (${modelProviders.tenantId} is null and not exists (
          select 1 from model_providers override
          where override.tenant_id = ${tenantId} and override.bifrost_provider = ${ROW_BIFROST_PROVIDER}
            and override.bifrost_key is not distinct from ${ROW_BIFROST_KEY}
            and override.base_format is not distinct from ${ROW_BASE_FORMAT}
        ))) and (coalesce((
          select availability.mode from ${modelProviderAvailability} availability where availability.name = ${ROW_NAME}
        ), 'every') = 'chosen') = exists (
          select 1 from ${modelProviderAvailabilityTenants} listed
          where listed.name = ${ROW_NAME} and listed.tenant_id = ${tenantId}
        )`
      )
      .orderBy(asc(modelProviders.bifrostProvider), asc(modelProviders.bifrostKey), asc(modelProviders.baseFormat));
  }

  private async writePlatformOverride(
    tx: DbExecutor,
    tenantId: string,
    row: ProviderRowIdentity,
    choice: ProviderSwitch,
    platformDefault: ProviderSwitch
  ): Promise<void> {
    const { bifrostProvider, bifrostKey, baseFormat } = row;
    if (sameSwitch(choice, platformDefault)) {
      await tx
        .delete(modelProviders)
        .where(
          and(
            eq(modelProviders.tenantId, tenantId),
            eq(modelProviders.bifrostProvider, bifrostProvider),
            bifrostKey ? eq(modelProviders.bifrostKey, bifrostKey) : isNull(modelProviders.bifrostKey),
            baseFormat ? eq(modelProviders.baseFormat, baseFormat) : isNull(modelProviders.baseFormat)
          )
        );
      return;
    }
    await tx
      .insert(modelProviders)
      .values({ tenantId, bifrostProvider, bifrostKey, baseFormat, ...choice })
      .onConflictDoUpdate({
        target: [
          modelProviders.tenantId,
          modelProviders.bifrostProvider,
          modelProviders.bifrostKey,
          modelProviders.baseFormat,
        ],
        set: choice,
      });
  }

  private async platformDefaults(executor: DbExecutor): Promise<Map<string, ProviderSwitch>> {
    const rows = await executor
      .select({
        bifrostProvider: modelProviders.bifrostProvider,
        bifrostKey: modelProviders.bifrostKey,
        baseFormat: modelProviders.baseFormat,
        chatEnabled: modelProviders.chatEnabled,
        chatWeight: modelProviders.chatWeight,
        backendEnabled: modelProviders.backendEnabled,
        backendWeight: modelProviders.backendWeight,
      })
      .from(modelProviders)
      .where(isNull(modelProviders.tenantId));
    return new Map(
      rows.map(({ bifrostProvider, bifrostKey, baseFormat, ...choice }) => [
        overrideKey({ bifrostProvider, bifrostKey, baseFormat }),
        choice,
      ])
    );
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
      .select({ bifrostProvider: modelProviders.bifrostProvider, bifrostKey: modelProviders.bifrostKey })
      .from(modelProviders)
      .where(isNull(modelProviders.tenantId));
    return new Set(rows.map(nameOfRow));
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

  private projectKeys(tx: DbExecutor, tenantId: string, scope?: ProjectKeyScope): Promise<ProjectKey[]> {
    return tx
      .select({ bifrostKeyId: projectVirtualKeys.bifrostKeyId, keyType: projectVirtualKeys.keyType })
      .from(projectVirtualKeys)
      .innerJoin(projects, eq(projects.id, projectVirtualKeys.projectId))
      .where(
        and(
          eq(projects.tenantId, tenantId),
          eq(projectVirtualKeys.status, 'active'),
          ...(scope ? [eq(projects.id, scope.projectId)] : [])
        )
      );
  }
}

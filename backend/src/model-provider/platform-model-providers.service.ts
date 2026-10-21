import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { modelProviders, tenants } from '../../db/schema';
import type { BifrostProviderSummary } from '../bifrost/bifrost.types';
import { lockPlatformModelProviders, type DbExecutor } from '../common/locks';
import {
  insertAwaitingSignIn,
  newCallerSecret,
  platformLinkedAccountVendors,
} from '../linked-accounts/linked-account-rows';
import { LinkedAccountVendorsService } from '../linked-accounts/linked-account-vendors.service';
import {
  PLATFORM_LINKED_ACCOUNT_NAMES,
  platformLinkedAccountVendorOf,
} from '../linked-accounts/platform-linked-accounts';
import {
  BASE_FORMATS,
  catalogModelsByFormat,
  creatableKindsByFormat,
  type BaseFormatId,
  type ModelProviderKind,
} from './base-formats';
import {
  isServedByLinkedAccountProxy,
  kindOf,
  servedModelsOf,
  type BifrostProviderSpec,
} from './bifrost-provider-shape';
import { AzureConnectionsService, formatsOfModels } from './azure-connections.service';
import { deploymentsOf, endpointOf, keyModelsOf } from './key-model-formats';
import {
  LINKED_ACCOUNT_SIGNS_IN_MESSAGE,
  ModelProviderConnectionsService,
  type NewProviderDraft,
} from './model-provider-connections.service';
import {
  AZURE_PROVIDER,
  ModelProvidersService,
  baseFormatOf,
  connectionKeyOf,
  isAvailable,
  nameOfRow,
  providersReadForKeys,
  rowStatusOf,
  servedSubsetOf,
  servingOf,
  type ProviderRowIdentity,
} from './model-provider.service';
import {
  STARTING_WEIGHT,
  type AvailabilityMode,
  type ConnectionTestPassed,
  type PlatformModelProviderAccessView,
  type PlatformModelProviderCreationRules,
  type PlatformModelProviderView,
  type PlatformModelProvidersView,
} from './model-provider.types';
import {
  PLATFORM_PROVIDER_PREFIX,
  assertCustomName,
  customNameMaxLength,
  isOpsiforceProviderName,
  platformBifrostProviderName,
} from './provider-names';
import { field, isLinkedAccountInput } from './request-fields';

interface FixedBuiltIn {
  format: BaseFormatId;
  apiKeySetting: 'openaiApiKey' | 'anthropicApiKey';
}

const FIXED_BUILT_INS: Record<string, FixedBuiltIn> = {
  openai: { format: 'openai', apiKeySetting: 'openaiApiKey' },
  anthropic: { format: 'anthropic', apiKeySetting: 'anthropicApiKey' },
};

const FIXED_KINDS: ModelProviderKind[] = ['official-api-key'];

const NAME_TAKEN_MESSAGE = 'That name is taken by another Built-in model provider; choose another';
const FIXED_UNDELETABLE_MESSAGE =
  'The built-in openai and anthropic can’t be deleted: transcription and apps depend on them';
const FIXED_URL_MESSAGE =
  'The built-in openai and anthropic always point at the vendor’s API; only their key can change';
const OPSIFORCE_ONLY_MESSAGE = 'Only opsiforce-* model providers and the key of openai and anthropic are managed here';
const AZURE_EDITS_ITS_CONNECTION_MESSAGE = 'An Azure connection is changed by editing it, with its key';

function isAzureFoundryInput(input: unknown): boolean {
  return field(input, 'kind') === 'azure-foundry';
}

function fixedBuiltInOf(name: string): FixedBuiltIn | undefined {
  return Object.hasOwn(FIXED_BUILT_INS, name) ? FIXED_BUILT_INS[name] : undefined;
}

function fixedSpec(name: string, fixed: FixedBuiltIn): BifrostProviderSpec {
  return {
    name,
    format: BASE_FORMATS[fixed.format],
    kind: 'official-api-key',
    adminTypedBaseUrl: null,
    standard: true,
  };
}

function urlOf(
  kind: ModelProviderKind | null,
  baseFormat: BaseFormatId | null,
  provider: BifrostProviderSummary | undefined,
  linkedAccountProxyUrl: string
): string | null {
  if (kind === 'compatible-endpoint') return provider?.baseUrl ?? null;
  if (kind === 'linked-account') {
    return isServedByLinkedAccountProxy(provider, linkedAccountProxyUrl) ? null : (provider?.baseUrl ?? null);
  }
  return baseFormat ? BASE_FORMATS[baseFormat].officialApiUrl : null;
}

@Injectable()
export class PlatformModelProvidersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformModelProvidersService.name);

  constructor(
    private readonly connections: ModelProviderConnectionsService,
    private readonly modelProvidersService: ModelProvidersService,
    private readonly configService: ConfigService,
    private readonly vendors: LinkedAccountVendorsService,
    private readonly azure: AzureConnectionsService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedFreshInstall();
    } catch (err) {
      this.logger.warn(`The fresh-install Model provider seed did not finish: ${(err as Error).message}`);
    }
  }

  async list(): Promise<PlatformModelProvidersView> {
    const [providers, entries, linkedAccountVendors, signIns] = await Promise.all([
      this.modelProvidersService.bifrostProvidersOrNull(),
      this.listedEntries(),
      platformLinkedAccountVendors(db),
      this.modelProvidersService.platformLinkedAccountSignIns(),
    ]);
    const keys = await this.modelProvidersService.keysOrEmpty(providersReadForKeys(entries, providers));
    return {
      bifrostReachable: providers !== null,
      providers: entries.map((entry): PlatformModelProviderView => {
        const name = nameOfRow(entry);
        const provider = providers?.get(entry.bifrostProvider);
        const fixed = fixedBuiltInOf(name);
        const linkedAccountVendor = platformLinkedAccountVendorOf(name) ?? linkedAccountVendors.get(name);
        const connection = entry.bifrostKey !== null;
        const baseFormat = entry.baseFormat ?? baseFormatOf(provider) ?? fixed?.format ?? null;
        const kind = connection
          ? 'azure-foundry'
          : fixed
            ? 'official-api-key'
            : linkedAccountVendor
              ? 'linked-account'
              : kindOf(provider, this.connections.linkedAccountProxyUrl);
        const connectionKey = connectionKeyOf(entry, keys);
        const view: PlatformModelProviderView = {
          name,
          baseFormat,
          kind,
          url: connection
            ? endpointOf(connectionKey)
            : urlOf(kind, baseFormat, provider, this.connections.linkedAccountProxyUrl),
          status: rowStatusOf(entry, providers, keys, this.connections.linkedAccountProxyUrl, signIns.get(name)),
          fixed: fixed !== undefined,
          notMetered: !connection && isOpsiforceProviderName(name),
        };
        const servedModels = servedSubsetOf(entry, servingOf(entry, providers, keys), providers);
        if (servedModels) view.servedModels = servedModels;
        if (connectionKey) {
          view.connection = { models: keyModelsOf([connectionKey]), deployments: deploymentsOf(connectionKey) };
        }
        if (linkedAccountVendor) view.linkedAccountVendor = linkedAccountVendor;
        return view;
      }),
    };
  }

  async access(): Promise<PlatformModelProviderAccessView> {
    const [providers, entries, tenantRows, availability] = await Promise.all([
      this.modelProvidersService.bifrostProvidersOrNull(),
      this.listedEntries(),
      db
        .select({ tenantId: tenants.id, name: tenants.name, displayName: tenants.displayName })
        .from(tenants)
        .orderBy(asc(tenants.displayName)),
      this.modelProvidersService.availability(),
    ]);
    const names = [...new Set(entries.map(nameOfRow))];
    return {
      providers: names.map((name) => {
        const formats = entries
          .filter((entry) => nameOfRow(entry) === name)
          .map(
            (entry) =>
              entry.baseFormat ?? baseFormatOf(providers?.get(entry.bifrostProvider)) ?? fixedBuiltInOf(name)?.format
          )
          .filter((format): format is BaseFormatId => format !== null && format !== undefined);
        return { name, baseFormats: [...new Set(formats)], mode: availability.modes.get(name) ?? 'every' };
      }),
      tenants: tenantRows.map((tenant) => ({
        ...tenant,
        withheld: names.filter((name) => !isAvailable(availability, name, tenant.tenantId)),
      })),
    };
  }

  async setAccess(name: string, tenantId: string, input: unknown): Promise<PlatformModelProviderAccessView> {
    const withheld = field(input, 'withheld');
    if (typeof withheld !== 'boolean') throw new BadRequestException('withheld must be true or false');
    if (!(await this.listedNames()).includes(name))
      throw new NotFoundException(`${name} is not a Built-in model provider`);
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new NotFoundException(`Organization ${tenantId} not found`);
    await this.modelProvidersService.setAvailableTo(tenantId, name, !withheld);
    return this.access();
  }

  async setAvailabilityMode(name: string, input: unknown): Promise<PlatformModelProviderAccessView> {
    const mode = field(input, 'mode');
    if (mode !== 'every' && mode !== 'chosen') throw new BadRequestException('mode is every or chosen');
    if (!(await this.listedNames()).includes(name))
      throw new NotFoundException(`${name} is not a Built-in model provider`);
    await db.transaction(async (tx) => {
      await lockPlatformModelProviders(tx);
      await this.modelProvidersService.setAvailabilityMode(tx, name, mode as AvailabilityMode);
    });
    return this.access();
  }

  private async listedNames(): Promise<string[]> {
    const rowNames = await this.modelProvidersService.platformProviderNames();
    return [...new Set([...rowNames, ...PLATFORM_LINKED_ACCOUNT_NAMES])].toSorted();
  }

  private async listedEntries(): Promise<ProviderRowIdentity[]> {
    const rows = await db
      .select({
        bifrostProvider: modelProviders.bifrostProvider,
        bifrostKey: modelProviders.bifrostKey,
        baseFormat: modelProviders.baseFormat,
      })
      .from(modelProviders)
      .where(isNull(modelProviders.tenantId));
    const unseededLinkedAccounts = PLATFORM_LINKED_ACCOUNT_NAMES.filter(
      (name) => !rows.some((row) => nameOfRow(row) === name)
    ).map((bifrostProvider) => ({ bifrostProvider, bifrostKey: null, baseFormat: null }));
    return [...rows, ...unseededLinkedAccounts].toSorted(
      (a, b) => nameOfRow(a).localeCompare(nameOfRow(b)) || (a.baseFormat ?? '').localeCompare(b.baseFormat ?? '')
    );
  }

  rules(): PlatformModelProviderCreationRules {
    return {
      namePrefix: `${PLATFORM_PROVIDER_PREFIX}-`,
      nameMaxLength: customNameMaxLength(PLATFORM_PROVIDER_PREFIX),
      kindsByFormat: creatableKindsByFormat(),
      catalogModels: catalogModelsByFormat((format) => servedModelsOf(format)),
    };
  }

  async test(input: unknown): Promise<ConnectionTestPassed> {
    if (isAzureFoundryInput(input)) {
      await this.azure.test(this.azure.connectionOf(input));
      return { passed: true };
    }
    await this.connections.testDraft(await this.prepare(input));
    return { passed: true };
  }

  async create(input: unknown): Promise<PlatformModelProvidersView> {
    const chosenTenantIds = await this.chosenTenantIdsOf(input);
    if (isLinkedAccountInput(input)) return this.createLinkedAccount(input, chosenTenantIds);
    if (isAzureFoundryInput(input)) return this.createAzureConnection(input, chosenTenantIds);
    const draft = await this.prepare(input);
    await this.connections.createDraft(draft, () =>
      db.transaction(async (tx) => {
        await lockPlatformModelProviders(tx);
        await this.assertNameFree(tx, draft.spec.name);
        await tx.insert(modelProviders).values({
          tenantId: null,
          bifrostProvider: draft.spec.name,
          chatEnabled: false,
          chatWeight: STARTING_WEIGHT,
        });
        await this.modelProvidersService.setInitialAvailability(tx, draft.spec.name, chosenTenantIds);
      })
    );
    return this.list();
  }

  private async createAzureConnection(
    input: unknown,
    chosenTenantIds: string[] | null
  ): Promise<PlatformModelProvidersView> {
    const name = await this.preparedName(input);
    const connection = this.azure.connectionOf(input);
    await this.azure.create(name, connection, () =>
      db.transaction(async (tx) => {
        await lockPlatformModelProviders(tx);
        await this.assertNameFree(tx, name);
        await tx.insert(modelProviders).values(
          formatsOfModels(connection.models).map((baseFormat) => ({
            tenantId: null,
            bifrostProvider: AZURE_PROVIDER,
            bifrostKey: name,
            baseFormat,
            chatEnabled: false,
            chatWeight: STARTING_WEIGHT,
          }))
        );
        await this.modelProvidersService.setInitialAvailability(tx, name, chosenTenantIds);
      })
    );
    return this.list();
  }

  private async chosenTenantIdsOf(input: unknown): Promise<string[] | null> {
    const availability = field(input, 'availability');
    if (availability === undefined || availability === null) return null;
    const mode = field(availability, 'mode');
    if (mode === 'every') return null;
    if (mode !== 'chosen') throw new BadRequestException('availability.mode is every or chosen');
    const tenantIds = field(availability, 'tenantIds');
    if (!Array.isArray(tenantIds) || tenantIds.some((tenantId) => typeof tenantId !== 'string')) {
      throw new BadRequestException('availability.tenantIds lists the organizations that can use it');
    }
    const unique = [...new Set(tenantIds as string[])];
    if (unique.length === 0) return [];
    const known = await db.select({ id: tenants.id }).from(tenants).where(inArray(tenants.id, unique));
    if (known.length !== unique.length)
      throw new BadRequestException('An organization in availability.tenantIds does not exist');
    return unique;
  }

  private async createLinkedAccount(
    input: unknown,
    chosenTenantIds: string[] | null
  ): Promise<PlatformModelProvidersView> {
    const { format, vendor } = this.connections.linkedAccountOf(input);
    const bifrostName = await this.preparedName(input);
    const callerSecret = newCallerSecret();
    await this.connections.createLinkedAccount(
      this.connections.linkedAccountSpec(bifrostName, format),
      callerSecret,
      () =>
        db.transaction(async (tx) => {
          await lockPlatformModelProviders(tx);
          await this.assertNameFree(tx, bifrostName);
          const [row] = await tx
            .insert(modelProviders)
            .values({ tenantId: null, bifrostProvider: bifrostName, chatEnabled: false, chatWeight: STARTING_WEIGHT })
            .returning({ id: modelProviders.id });
          if (!row) throw new Error(`The platform row of ${bifrostName} was not created`);
          await insertAwaitingSignIn(tx, row.id, vendor, callerSecret);
          await this.modelProvidersService.setInitialAvailability(tx, bifrostName, chosenTenantIds);
        })
    );
    return this.list();
  }

  async editConnection(name: string, input: unknown): Promise<PlatformModelProvidersView> {
    if (await this.isPlatformAzureConnection(name)) return this.editAzureConnection(name, input);
    const edit = this.connections.connectionEditOf(input);
    const fixed = await this.fixedBuiltInOfPlatformProvider(name);
    if (fixed && edit.movesBaseUrl) throw new BadRequestException(FIXED_URL_MESSAGE);
    const provider = await this.connections.find(name);
    if (!provider) throw new ConflictException(`The model gateway no longer has ${name}; re-enter its key instead`);
    const current = fixed ? fixedSpec(name, fixed) : this.connections.currentSpecOf(name, provider);
    if (!current) throw new BadRequestException(`${name} can't be edited here`);
    await this.connections.replaceConnection(current, edit);
    return this.list();
  }

  private async editAzureConnection(name: string, input: unknown): Promise<PlatformModelProvidersView> {
    if (!isOpsiforceProviderName(name)) throw new BadRequestException(OPSIFORCE_ONLY_MESSAGE);
    await this.azure.replaceAccess(name, this.azure.accessOf(input));
    return this.list();
  }

  async setModels(name: string, input: unknown): Promise<PlatformModelProvidersView> {
    if (await this.isPlatformAzureConnection(name)) {
      const choice = this.azure.modelsOf(input);
      let putKeyBack: (() => Promise<void>) | undefined;
      try {
        await db.transaction(async (tx) => {
          await lockPlatformModelProviders(tx);
          if (!(await this.isPlatformAzureConnection(name, tx))) {
            throw new NotFoundException(`${name} is not a Built-in model provider`);
          }
          putKeyBack = await this.azure.setModels(name, choice);
          await this.keepAzureRowsFor(tx, name, formatsOfModels(choice.models));
        });
      } catch (err) {
        await putKeyBack?.();
        throw err;
      }
    } else {
      if (!(await this.listedNames()).includes(name))
        throw new NotFoundException(`${name} is not a Built-in model provider`);
      const provider = await this.connections.find(name);
      const format = baseFormatOf(provider ?? undefined) ?? fixedBuiltInOf(name)?.format;
      if (!provider || !format)
        throw new ConflictException(`The model gateway no longer has ${name}; re-enter its key first`);
      await this.connections.setModels(name, BASE_FORMATS[format], input);
    }
    const failed = await this.modelProvidersService.rewriteEveryTenantsKeys();
    if (failed.length > 0) {
      throw new BadGatewayException(
        `${name} now serves the models you chose, but ${failed.length} organizations still route the old ones. Save again to retry.`
      );
    }
    return this.list();
  }

  private async keepAzureRowsFor(tx: DbExecutor, name: string, formats: BaseFormatId[]): Promise<void> {
    await tx
      .delete(modelProviders)
      .where(and(eq(modelProviders.bifrostKey, name), notInArray(modelProviders.baseFormat, formats)));
    await tx
      .insert(modelProviders)
      .values(
        formats.map((baseFormat) => ({
          tenantId: null,
          bifrostProvider: AZURE_PROVIDER,
          bifrostKey: name,
          baseFormat,
          chatEnabled: false,
          chatWeight: STARTING_WEIGHT,
        }))
      )
      .onConflictDoNothing();
  }

  private async isPlatformAzureConnection(name: string, executor: DbExecutor = db): Promise<boolean> {
    const [row] = await executor
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          isNull(modelProviders.tenantId),
          eq(modelProviders.bifrostProvider, AZURE_PROVIDER),
          eq(modelProviders.bifrostKey, name)
        )
      )
      .limit(1);
    return row !== undefined;
  }

  async reenterKey(name: string, input: unknown): Promise<PlatformModelProvidersView> {
    if (await this.isPlatformAzureConnection(name)) throw new BadRequestException(AZURE_EDITS_ITS_CONNECTION_MESSAGE);
    const fixed = await this.fixedBuiltInOfPlatformProvider(name);
    if ((await platformLinkedAccountVendors(db)).has(name)) {
      throw new BadRequestException(LINKED_ACCOUNT_SIGNS_IN_MESSAGE);
    }
    if (await this.connections.find(name)) {
      throw new ConflictException(`The model gateway still has ${name}; edit its connection instead`);
    }
    const draft = fixed ? this.fixedDraft(name, fixed, input) : this.connections.draftOf(name, input);
    await this.connections.createDraft(draft, () =>
      db.transaction(async (tx) => {
        await this.modelProvidersService.rewriteKeysOfTenantsUsing(tx, name);
      })
    );
    return this.list();
  }

  async delete(name: string): Promise<PlatformModelProvidersView> {
    if (await this.fixedBuiltInOfPlatformProvider(name)) throw new BadRequestException(FIXED_UNDELETABLE_MESSAGE);
    if (!isOpsiforceProviderName(name)) throw new BadRequestException(OPSIFORCE_ONLY_MESSAGE);
    const azureConnection = await this.isPlatformAzureConnection(name);
    let affectedTenantIds: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await lockPlatformModelProviders(tx);
        affectedTenantIds = await this.modelProvidersService.tenantIdsUsing(tx, name);
        if (azureConnection) {
          await tx.delete(modelProviders).where(eq(modelProviders.bifrostKey, name));
        } else {
          const [platformRow] = await tx
            .select({ id: modelProviders.id })
            .from(modelProviders)
            .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, name)));
          if (platformRow) await this.vendors.revokeStoredSignIn(tx, platformRow.id);
          await tx.delete(modelProviders).where(eq(modelProviders.bifrostProvider, name));
        }
        await this.modelProvidersService.forgetAvailability(tx, name);
        for (const tenantId of affectedTenantIds) {
          await this.modelProvidersService.writeTenantKeys(tx, tenantId);
        }
        if (azureConnection) await this.azure.remove(name);
        else await this.connections.remove(name);
      });
    } catch (err) {
      if (err instanceof BadGatewayException) await this.modelProvidersService.restoreTenantKeys(affectedTenantIds);
      throw err;
    }
    return this.list();
  }

  async seedFreshInstall(): Promise<void> {
    if (!this.connections.isBifrostConfigured()) return;
    await db.transaction(async (tx) => {
      await lockPlatformModelProviders(tx);
      if ((await this.modelProvidersService.platformProviderNames(tx)).size > 0) return;
      const insertSeedRow = async (name: string): Promise<void> => {
        await tx.insert(modelProviders).values({
          tenantId: null,
          bifrostProvider: name,
          chatEnabled: true,
          chatWeight: STARTING_WEIGHT,
          backendEnabled: true,
          backendWeight: STARTING_WEIGHT,
        });
      };
      for (const [name, fixed] of Object.entries(FIXED_BUILT_INS)) {
        if (await this.connections.find(name)) {
          await insertSeedRow(name);
          this.logger.log(`Adopted the built-in ${name} model provider the model gateway already has`);
          continue;
        }
        const key = this.configService.get<string>(fixed.apiKeySetting, '');
        if (!key) continue;
        try {
          await this.connections.createDraft({ spec: fixedSpec(name, fixed), key }, () => insertSeedRow(name));
          this.logger.log(`Seeded the built-in ${name} model provider from the environment`);
        } catch (err) {
          this.logger.warn(`The built-in ${name} model provider was not seeded: ${(err as Error).message}`);
        }
      }
    });
  }

  private async prepare(input: unknown): Promise<NewProviderDraft> {
    const connection = this.connections.connectionOf(input);
    const bifrostName = await this.preparedName(input);
    return { spec: { name: bifrostName, ...connection.spec }, key: connection.key };
  }

  private async preparedName(input: unknown): Promise<string> {
    const name = field(input, 'name');
    assertCustomName(PLATFORM_PROVIDER_PREFIX, name);
    this.connections.assertBifrostConfigured();
    const bifrostName = platformBifrostProviderName(name);
    await this.assertNameFree(db, bifrostName);
    return bifrostName;
  }

  private fixedDraft(name: string, fixed: FixedBuiltIn, input: unknown): NewProviderDraft {
    const connection = this.connections.connectionOf(input, () => FIXED_KINDS);
    if (connection.spec.format.id !== fixed.format) {
      throw new BadRequestException(`The built-in ${name} is always ${fixed.format} format`);
    }
    return { spec: fixedSpec(name, fixed), key: connection.key };
  }

  private async fixedBuiltInOfPlatformProvider(name: string): Promise<FixedBuiltIn | undefined> {
    this.connections.assertBifrostConfigured();
    if (!(await this.modelProvidersService.platformProviderNames()).has(name)) {
      throw new NotFoundException(`${name} is not a Built-in model provider`);
    }
    const fixed = fixedBuiltInOf(name);
    if (!fixed && !isOpsiforceProviderName(name)) throw new BadRequestException(OPSIFORCE_ONLY_MESSAGE);
    return fixed;
  }

  private async assertNameFree(executor: DbExecutor, bifrostName: string): Promise<void> {
    const [taken] = await executor
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(sql`coalesce(${modelProviders.bifrostKey}, ${modelProviders.bifrostProvider}) = ${bifrostName}`);
    if (taken) throw new ConflictException(NAME_TAKEN_MESSAGE);
  }
}

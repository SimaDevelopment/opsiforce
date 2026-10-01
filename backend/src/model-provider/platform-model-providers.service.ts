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
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { modelProviders } from '../../db/schema';
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
import { BASE_FORMATS, creatableKindsByFormat, type BaseFormatId, type ModelProviderKind } from './base-formats';
import { isServedByLinkedAccountProxy, kindOf, type BifrostProviderSpec } from './bifrost-provider-shape';
import {
  LINKED_ACCOUNT_SIGNS_IN_MESSAGE,
  ModelProviderConnectionsService,
  type NewProviderDraft,
} from './model-provider-connections.service';
import { ModelProvidersService, baseFormatOf, statusOf } from './model-provider.service';
import {
  STARTING_WEIGHT,
  type ConnectionTestPassed,
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
    private readonly vendors: LinkedAccountVendorsService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedFreshInstall();
    } catch (err) {
      this.logger.warn(`The fresh-install Model provider seed did not finish: ${(err as Error).message}`);
    }
  }

  async list(): Promise<PlatformModelProvidersView> {
    const [providers, rowNames, linkedAccountVendors, signIns] = await Promise.all([
      this.modelProvidersService.bifrostProvidersOrNull(),
      this.modelProvidersService.platformProviderNames(),
      platformLinkedAccountVendors(db),
      this.modelProvidersService.platformLinkedAccountSignIns(),
    ]);
    const names = [...new Set([...rowNames, ...PLATFORM_LINKED_ACCOUNT_NAMES])].toSorted();
    return {
      bifrostReachable: providers !== null,
      providers: names.map((name): PlatformModelProviderView => {
        const provider = providers?.get(name);
        const fixed = fixedBuiltInOf(name);
        const linkedAccountVendor = platformLinkedAccountVendorOf(name) ?? linkedAccountVendors.get(name);
        const baseFormat = baseFormatOf(provider) ?? fixed?.format ?? null;
        const kind = fixed
          ? 'official-api-key'
          : linkedAccountVendor
            ? 'linked-account'
            : kindOf(provider, this.connections.linkedAccountProxyUrl);
        const view: PlatformModelProviderView = {
          name,
          baseFormat,
          kind,
          url: urlOf(kind, baseFormat, provider, this.connections.linkedAccountProxyUrl),
          status: statusOf(providers, name, this.connections.linkedAccountProxyUrl, signIns.get(name)),
          fixed: fixed !== undefined,
          notMetered: isOpsiforceProviderName(name),
        };
        if (linkedAccountVendor) view.linkedAccountVendor = linkedAccountVendor;
        return view;
      }),
    };
  }

  rules(): PlatformModelProviderCreationRules {
    return {
      namePrefix: `${PLATFORM_PROVIDER_PREFIX}-`,
      nameMaxLength: customNameMaxLength(PLATFORM_PROVIDER_PREFIX),
      kindsByFormat: creatableKindsByFormat(),
    };
  }

  async test(input: unknown): Promise<ConnectionTestPassed> {
    await this.connections.testDraft(await this.prepare(input));
    return { passed: true };
  }

  async create(input: unknown): Promise<PlatformModelProvidersView> {
    if (isLinkedAccountInput(input)) return this.createLinkedAccount(input);
    const draft = await this.prepare(input);
    await this.connections.createDraft(draft, () =>
      db.transaction(async (tx) => {
        await lockPlatformModelProviders(tx);
        await this.assertNameFree(tx, draft.spec.name);
        await tx
          .insert(modelProviders)
          .values({ tenantId: null, bifrostProvider: draft.spec.name, enabled: false, weight: STARTING_WEIGHT });
      })
    );
    return this.list();
  }

  private async createLinkedAccount(input: unknown): Promise<PlatformModelProvidersView> {
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
            .values({ tenantId: null, bifrostProvider: bifrostName, enabled: false, weight: STARTING_WEIGHT })
            .returning({ id: modelProviders.id });
          if (!row) throw new Error(`The platform row of ${bifrostName} was not created`);
          await insertAwaitingSignIn(tx, row.id, vendor, callerSecret);
        })
    );
    return this.list();
  }

  async editConnection(name: string, input: unknown): Promise<PlatformModelProvidersView> {
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

  async reenterKey(name: string, input: unknown): Promise<PlatformModelProvidersView> {
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
        await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, name);
      })
    );
    return this.list();
  }

  async delete(name: string): Promise<PlatformModelProvidersView> {
    if (await this.fixedBuiltInOfPlatformProvider(name)) throw new BadRequestException(FIXED_UNDELETABLE_MESSAGE);
    let affectedTenantIds: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await lockPlatformModelProviders(tx);
        affectedTenantIds = await this.modelProvidersService.tenantIdsUsing(tx, name);
        const [platformRow] = await tx
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, name)));
        if (platformRow) await this.vendors.revokeStoredSignIn(tx, platformRow.id);
        await tx.delete(modelProviders).where(eq(modelProviders.bifrostProvider, name));
        for (const tenantId of affectedTenantIds) {
          await this.modelProvidersService.rewriteTenantChatKeys(tx, tenantId);
        }
        await this.connections.remove(name);
      });
    } catch (err) {
      if (err instanceof BadGatewayException) await this.modelProvidersService.restoreTenantChatKeys(affectedTenantIds);
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
        await tx
          .insert(modelProviders)
          .values({ tenantId: null, bifrostProvider: name, enabled: true, weight: STARTING_WEIGHT });
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
      .where(eq(modelProviders.bifrostProvider, bifrostName));
    if (taken) throw new ConflictException(NAME_TAKEN_MESSAGE);
  }
}

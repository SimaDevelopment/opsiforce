import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { linkedAccounts, modelProviders } from '../../db/schema';
import type { BifrostProviderSummary } from '../bifrost/bifrost.types';
import { lockTenantModelProviders, type DbExecutor } from '../common/locks';
import { insertAwaitingSignIn, newCallerSecret } from '../linked-accounts/linked-account-rows';
import { LinkedAccountVendorsService } from '../linked-accounts/linked-account-vendors.service';
import type { TenantContext } from '../tenant/tenant.decorator';
import { creatableKindsByFormat } from './base-formats';
import {
  LINKED_ACCOUNT_SIGNS_IN_MESSAGE,
  ModelProviderConnectionsService,
  NAME_TAKEN_MESSAGE,
  type NewProviderDraft,
} from './model-provider-connections.service';
import { ModelProvidersService } from './model-provider.service';
import {
  CUSTOM_MODEL_PROVIDER_LIMIT,
  STARTING_WEIGHT,
  type ConnectionTestPassed,
  type ModelProviderCreationRules,
  type TenantModelProvidersView,
} from './model-provider.types';
import { assertCustomName, customBifrostProviderName, customNameMaxLength } from './provider-names';
import { field, isLinkedAccountInput } from './request-fields';

const CUSTOM_LIMIT_MESSAGE = `An organization can have at most ${CUSTOM_MODEL_PROVIDER_LIMIT} Custom model providers; delete one to add another`;
const BUILT_IN_UNDELETABLE_MESSAGE = 'Built-in model providers can’t be deleted';
const BUILT_IN_UNEDITABLE_MESSAGE = 'Built-in model providers can’t be edited';

interface CustomProviderInBifrost {
  bifrostName: string;
  provider: BifrostProviderSummary | null;
  linkedAccount: boolean;
}

@Injectable()
export class ModelProviderCreationService {
  constructor(
    private readonly connections: ModelProviderConnectionsService,
    private readonly modelProvidersService: ModelProvidersService,
    private readonly vendors: LinkedAccountVendorsService
  ) {}

  async rules(tenant: TenantContext): Promise<ModelProviderCreationRules> {
    return {
      nameMaxLength: customNameMaxLength(tenant.tenantName),
      customProviderLimit: CUSTOM_MODEL_PROVIDER_LIMIT,
      customProviderCount: (await this.customProviderNames(db, tenant.tenantId)).length,
      kindsByFormat: creatableKindsByFormat(),
    };
  }

  async test(tenant: TenantContext, input: unknown): Promise<ConnectionTestPassed> {
    await this.connections.testDraft(await this.prepare(tenant, input));
    return { passed: true };
  }

  async create(tenant: TenantContext, input: unknown): Promise<TenantModelProvidersView> {
    if (isLinkedAccountInput(input)) return this.createLinkedAccount(tenant, input);
    const draft = await this.prepare(tenant, input);
    await this.connections.createDraft(draft, () =>
      db.transaction(async (tx) => {
        await lockTenantModelProviders(tx, tenant.tenantId);
        await this.assertNameFreeAndUnderLimit(tx, tenant, draft.spec.name);
        await tx
          .insert(modelProviders)
          .values({
            tenantId: tenant.tenantId,
            bifrostProvider: draft.spec.name,
            enabled: true,
            weight: STARTING_WEIGHT,
          });
        await this.modelProvidersService.rewriteTenantChatKeys(tx, tenant.tenantId);
      })
    );
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  async delete(tenant: TenantContext, name: string): Promise<TenantModelProvidersView> {
    this.connections.assertBifrostConfigured();
    const bifrostName = customBifrostProviderName(tenant.tenantName, name);
    try {
      await db.transaction(async (tx) => {
        await lockTenantModelProviders(tx, tenant.tenantId);
        const [row] = await tx
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(and(eq(modelProviders.tenantId, tenant.tenantId), eq(modelProviders.bifrostProvider, bifrostName)));
        if (!row) {
          if ((await this.modelProvidersService.platformProviderNames(tx)).has(name)) {
            throw new BadRequestException(BUILT_IN_UNDELETABLE_MESSAGE);
          }
          throw new NotFoundException(`${name} is not a model provider of this organization`);
        }
        await this.vendors.revokeStoredSignIn(tx, row.id);
        await tx.delete(modelProviders).where(eq(modelProviders.id, row.id));
        await this.modelProvidersService.rewriteTenantChatKeys(tx, tenant.tenantId);
        await this.connections.remove(bifrostName);
      });
    } catch (err) {
      if (err instanceof BadGatewayException) await this.modelProvidersService.restoreTenantChatKeys([tenant.tenantId]);
      throw err;
    }
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  private async createLinkedAccount(tenant: TenantContext, input: unknown): Promise<TenantModelProvidersView> {
    const { format, vendor } = this.connections.linkedAccountOf(input);
    const bifrostName = await this.preparedName(tenant, input);
    const callerSecret = newCallerSecret();
    await this.connections.createLinkedAccount(
      this.connections.linkedAccountSpec(bifrostName, format),
      callerSecret,
      () =>
        db.transaction(async (tx) => {
          await lockTenantModelProviders(tx, tenant.tenantId);
          await this.assertNameFreeAndUnderLimit(tx, tenant, bifrostName);
          const [row] = await tx
            .insert(modelProviders)
            .values({ tenantId: tenant.tenantId, bifrostProvider: bifrostName, enabled: true, weight: STARTING_WEIGHT })
            .returning({ id: modelProviders.id });
          if (!row) throw new Error(`The row of ${bifrostName} was not created`);
          await insertAwaitingSignIn(tx, row.id, vendor, callerSecret);
        })
    );
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  async editConnection(tenant: TenantContext, name: string, input: unknown): Promise<TenantModelProvidersView> {
    const edit = this.connections.connectionEditOf(input);
    const { bifrostName, provider } = await this.customProviderInBifrost(tenant, name);
    if (!provider) {
      throw new ConflictException(`The model gateway no longer has ${name}; re-enter its key instead`);
    }
    const current = this.connections.currentSpecOf(bifrostName, provider);
    if (!current) throw new BadRequestException(`${name} can't be edited here`);
    await this.connections.replaceConnection(current, edit);
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  async reenterKey(tenant: TenantContext, name: string, input: unknown): Promise<TenantModelProvidersView> {
    const { bifrostName, provider, linkedAccount } = await this.customProviderInBifrost(tenant, name);
    if (linkedAccount) throw new BadRequestException(LINKED_ACCOUNT_SIGNS_IN_MESSAGE);
    if (provider) throw new ConflictException(`The model gateway still has ${name}; edit its connection instead`);
    const draft = this.connections.draftOf(bifrostName, input);
    await this.connections.createDraft(draft, () =>
      db.transaction(async (tx) => {
        await lockTenantModelProviders(tx, tenant.tenantId);
        await this.modelProvidersService.rewriteTenantChatKeys(tx, tenant.tenantId);
      })
    );
    return this.modelProvidersService.listTenantProviders(tenant);
  }

  private async prepare(tenant: TenantContext, input: unknown): Promise<NewProviderDraft> {
    const connection = this.connections.connectionOf(input);
    const bifrostName = await this.preparedName(tenant, input);
    return { spec: { name: bifrostName, ...connection.spec }, key: connection.key };
  }

  private async preparedName(tenant: TenantContext, input: unknown): Promise<string> {
    const name = field(input, 'name');
    assertCustomName(tenant.tenantName, name);
    this.connections.assertBifrostConfigured();
    const bifrostName = customBifrostProviderName(tenant.tenantName, name);
    await this.assertNameFreeAndUnderLimit(db, tenant, bifrostName);
    return bifrostName;
  }

  private async customProviderInBifrost(tenant: TenantContext, name: string): Promise<CustomProviderInBifrost> {
    this.connections.assertBifrostConfigured();
    const bifrostName = customBifrostProviderName(tenant.tenantName, name);
    const [row] = await db
      .select({ id: modelProviders.id, linkedAccountVendor: linkedAccounts.vendor })
      .from(modelProviders)
      .leftJoin(linkedAccounts, eq(linkedAccounts.modelProviderId, modelProviders.id))
      .where(and(eq(modelProviders.tenantId, tenant.tenantId), eq(modelProviders.bifrostProvider, bifrostName)));
    if (!row) {
      if ((await this.modelProvidersService.platformProviderNames()).has(name)) {
        throw new BadRequestException(BUILT_IN_UNEDITABLE_MESSAGE);
      }
      throw new NotFoundException(`${name} is not a model provider of this organization`);
    }
    return {
      bifrostName,
      provider: await this.connections.find(bifrostName),
      linkedAccount: row.linkedAccountVendor !== null,
    };
  }

  private async assertNameFreeAndUnderLimit(
    executor: DbExecutor,
    tenant: TenantContext,
    bifrostName: string
  ): Promise<void> {
    const [taken] = await executor
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.bifrostProvider, bifrostName));
    if (taken) throw new ConflictException(NAME_TAKEN_MESSAGE);
    if ((await this.customProviderNames(executor, tenant.tenantId)).length >= CUSTOM_MODEL_PROVIDER_LIMIT) {
      throw new ConflictException(CUSTOM_LIMIT_MESSAGE);
    }
  }

  private async customProviderNames(executor: DbExecutor, tenantId: string): Promise<string[]> {
    const [rows, platformNames] = await Promise.all([
      executor
        .select({ bifrostProvider: modelProviders.bifrostProvider })
        .from(modelProviders)
        .where(eq(modelProviders.tenantId, tenantId)),
      this.modelProvidersService.platformProviderNames(executor),
    ]);
    return rows.map((row) => row.bifrostProvider).filter((name) => !platformNames.has(name));
  }
}

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BifrostApiError, BifrostService } from '../bifrost/bifrost.service';
import type { BifrostProviderSummary, UpdateBifrostProviderRequest } from '../bifrost/bifrost.types';
import { VENDOR_BASE_FORMAT, isVendorId } from '../linked-accounts/vendors';
import type { VendorId } from '../linked-accounts/vendor-adapter';
import {
  BASE_FORMATS,
  creatableKinds,
  isBaseFormatId,
  keyedKinds,
  type BaseFormat,
  type ModelProviderKind,
} from './base-formats';
import {
  bifrostProviderKey,
  bifrostProviderKeyName,
  bifrostProviderPayload,
  bifrostProviderUpdatePayload,
  isServedByLinkedAccountProxy,
  kindOf,
  servedModelsOf,
  type BifrostProviderSpec,
} from './bifrost-provider-shape';
import { testConnection } from './connection-test';
import { TRANSCRIPTION_MODEL_ID, TRANSCRIPTION_PROVIDER } from '../transcription/transcription.constants';
import { isHelmPlaceholder } from './key-model-formats';
import { baseFormatOf } from './model-provider.service';
import { BIFROST_UNREACHABLE_MESSAGE } from './model-provider.types';
import { field } from './request-fields';

export const NAME_TAKEN_MESSAGE = 'That name is taken in this organization; choose another';
const ENTER_KEY_MESSAGE = 'Enter the key';
const ENTER_HTTPS_BASE_URL_MESSAGE = 'Enter an https:// base URL';
const OFFICIAL_KEY_HAS_NO_BASE_URL_MESSAGE = 'An Official API key has no base URL';
const FIXED_IDENTITY_MESSAGE = 'The name and Base format of a model provider are fixed';
const FIXED_IDENTITY_FIELDS = ['name', 'baseFormat', 'kind'];
const EVERY_MODEL = ['*'];
const NOT_IN_GATEWAY_MESSAGE = 'The model gateway no longer has this model provider; re-enter its key first';
const NO_KEY_FOR_MODELS_MESSAGE = 'Sign this model provider in first, then choose its models';
export const LINKED_ACCOUNT_SIGNS_IN_MESSAGE = 'A Linked account connects by signing in, not with a key';
const CHOOSE_VENDOR_MESSAGE = 'Choose which account to link';
const GATEWAY_KEPT_PROVIDER_MESSAGE =
  'The model gateway did not remove the provider it was asked to remove; try again in a moment';

export interface NewProviderDraft {
  spec: BifrostProviderSpec;
  key: string;
}

export type ProviderConnection = { spec: Omit<BifrostProviderSpec, 'name'>; key: string };

export interface LinkedAccountConnection {
  format: BaseFormat;
  vendor: VendorId;
}

export interface ConnectionEdit {
  key: string;
  movesBaseUrl: boolean;
  input: unknown;
}

function requiredKey(input: unknown): string {
  const key = field(input, 'key');
  if (typeof key !== 'string' || key.trim() === '') throw new BadRequestException(ENTER_KEY_MESSAGE);
  return key;
}

function httpsBaseUrl(input: unknown): string {
  const typed = typeof input === 'string' ? input.trim() : '';
  if (!URL.canParse(typed) || new URL(typed).protocol !== 'https:') {
    throw new BadRequestException(ENTER_HTTPS_BASE_URL_MESSAGE);
  }
  return typed.replace(/\/+$/, '');
}

function adminTypedBaseUrlFor(kind: ModelProviderKind, input: unknown): string | null {
  const baseUrl = field(input, 'baseUrl');
  if (kind === 'compatible-endpoint') return httpsBaseUrl(baseUrl);
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
    throw new BadRequestException(OFFICIAL_KEY_HAS_NO_BASE_URL_MESSAGE);
  }
  return null;
}

export function formatModelsOf(input: unknown, format: BaseFormat): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  const catalog = servedModelsOf(format);
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException('Choose at least one model it serves');
  const models = [...new Set(input)];
  for (const model of models) {
    if (typeof model !== 'string' || !catalog.includes(model)) {
      throw new BadRequestException(`${String(model)} is not a ${format.id} model of the catalog`);
    }
  }
  return catalog.every((model) => models.includes(model)) ? undefined : (models as string[]);
}

function storedModelsOf(models: string[] | undefined): string[] | undefined {
  return !models || models.includes('*') ? undefined : models;
}

function formatOf(input: unknown): BaseFormat {
  const baseFormat = field(input, 'baseFormat');
  if (typeof baseFormat !== 'string' || !isBaseFormatId(baseFormat)) {
    throw new BadRequestException('Choose a Base format');
  }
  return BASE_FORMATS[baseFormat];
}

@Injectable()
export class ModelProviderConnectionsService {
  private readonly logger = new Logger(ModelProviderConnectionsService.name);
  private readonly officialApiUrlOverrides: Record<string, string>;
  readonly linkedAccountProxyUrl: string;

  constructor(
    private readonly bifrostService: BifrostService,
    configService: ConfigService
  ) {
    this.officialApiUrlOverrides = configService.get<Record<string, string>>('modelProviderOfficialApiUrls', {});
    this.linkedAccountProxyUrl = configService.getOrThrow<string>('linkedAccountProxyUrl');
  }

  connectionOf(input: unknown, kindsOf: (format: BaseFormat) => ModelProviderKind[] = keyedKinds) {
    const format = formatOf(input);
    const kind = field(input, 'kind');
    if (typeof kind !== 'string' || !kindsOf(format).includes(kind as ModelProviderKind)) {
      if (kind === 'linked-account' && creatableKinds(format).includes(kind)) {
        throw new BadRequestException(LINKED_ACCOUNT_SIGNS_IN_MESSAGE);
      }
      throw new BadRequestException(`A ${format.id} model provider can't connect that way`);
    }
    const key = requiredKey(input);
    const adminTypedBaseUrl = adminTypedBaseUrlFor(kind as ModelProviderKind, input);
    const models = formatModelsOf(field(input, 'models'), format);
    return {
      spec: { format, kind: kind as ModelProviderKind, adminTypedBaseUrl, ...(models ? { models } : {}) },
      key,
    } satisfies ProviderConnection;
  }

  draftOf(name: string, input: unknown): NewProviderDraft {
    const connection = this.connectionOf(input);
    return { spec: { name, ...connection.spec }, key: connection.key };
  }

  linkedAccountOf(input: unknown): LinkedAccountConnection {
    const format = formatOf(input);
    if (!creatableKinds(format).includes('linked-account')) {
      throw new BadRequestException(`A ${format.id} model provider can't connect that way`);
    }
    const vendor = field(input, 'vendor');
    if (!isVendorId(vendor) || VENDOR_BASE_FORMAT[vendor] !== format.id) {
      throw new BadRequestException(CHOOSE_VENDOR_MESSAGE);
    }
    return { format, vendor };
  }

  isBifrostConfigured(): boolean {
    return this.bifrostService.isEnabled();
  }

  assertBifrostConfigured(): void {
    if (!this.isBifrostConfigured()) throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
  }

  find(bifrostName: string): Promise<BifrostProviderSummary | null> {
    return this.bifrostCall(() => this.bifrostService.findProvider(bifrostName));
  }

  async testDraft(draft: NewProviderDraft): Promise<void> {
    await this.createInBifrost(draft);
    try {
      await this.passConnectionTest(draft.spec, draft.key);
    } finally {
      await this.remove(draft.spec.name);
    }
  }

  async createDraft(draft: NewProviderDraft, persist: () => Promise<void>): Promise<void> {
    await this.createInBifrost(draft);
    try {
      await this.passConnectionTest(draft.spec, draft.key);
      await this.bifrostService.addProviderKey(draft.spec.name, bifrostProviderKey(draft.spec, draft.key));
      await persist();
    } catch (err) {
      await this.remove(draft.spec.name);
      throw err;
    }
  }

  currentSpecOf(bifrostName: string, provider: BifrostProviderSummary): BifrostProviderSpec | null {
    const format = baseFormatOf(provider);
    const kind = kindOf(provider, this.linkedAccountProxyUrl);
    if (!format || !kind) return null;
    if (kind === 'linked-account') return this.linkedAccountSpec(bifrostName, BASE_FORMATS[format]);
    return { name: bifrostName, format: BASE_FORMATS[format], kind, adminTypedBaseUrl: provider.baseUrl };
  }

  linkedAccountSpec(bifrostName: string, format: BaseFormat): BifrostProviderSpec {
    return {
      name: bifrostName,
      format,
      kind: 'linked-account',
      adminTypedBaseUrl: null,
      backendWrittenBaseUrl: this.linkedAccountProxyUrl,
    };
  }

  async createLinkedAccount(
    spec: BifrostProviderSpec,
    callerSecret: string,
    persist: () => Promise<void>
  ): Promise<void> {
    await this.createInBifrost({ spec, key: callerSecret });
    try {
      await this.bifrostService.addProviderKey(spec.name, bifrostProviderKey(spec, callerSecret));
      await persist();
    } catch (err) {
      await this.remove(spec.name);
      throw err;
    }
  }

  async servesThroughLinkedAccountProxy(bifrostName: string): Promise<boolean> {
    const provider = await this.find(bifrostName);
    if (!provider || provider.keyLess || !isServedByLinkedAccountProxy(provider, this.linkedAccountProxyUrl)) {
      return false;
    }
    const keys = await this.bifrostCall(() => this.bifrostService.listProviderKeys(bifrostName));
    return keys.some((key) => key.name === bifrostProviderKeyName(bifrostName));
  }

  async pointAtLinkedAccountProxy(spec: BifrostProviderSpec, callerSecret: string): Promise<void> {
    const key = bifrostProviderKey(spec, callerSecret);
    const existing = await this.find(spec.name);
    if (!existing) {
      await this.createLinkedAccount(spec, callerSecret, async () => {});
      return;
    }
    const previous = await this.bifrostCall(() => this.bifrostService.providerConfig(spec.name));
    await this.updateInBifrost(spec);
    try {
      const [storedKey] = await this.bifrostCall(() => this.bifrostService.listProviderKeys(spec.name));
      const ownKey = storedKey?.name === key.name;
      const keepingModels = { ...key, models: (ownKey ? storedModelsOf(storedKey.models) : undefined) ?? key.models };
      await this.bifrostCall(() =>
        storedKey?.id
          ? this.bifrostService.replaceProviderKey(spec.name, storedKey.id, keepingModels)
          : this.bifrostService.addProviderKey(spec.name, keepingModels)
      );
    } catch (err) {
      await this.restoreInBifrost(spec.name, previous);
      throw err;
    }
  }

  connectionEditOf(input: unknown): ConnectionEdit {
    if (FIXED_IDENTITY_FIELDS.some((fixed) => field(input, fixed) !== undefined)) {
      throw new BadRequestException(FIXED_IDENTITY_MESSAGE);
    }
    return { key: requiredKey(input), movesBaseUrl: field(input, 'baseUrl') !== undefined, input };
  }

  async setModels(bifrostName: string, format: BaseFormat, input: unknown): Promise<void> {
    const chosen = formatModelsOf(field(input, 'models'), format);
    const models = chosen ? [...chosen, ...this.modelsAlwaysServedBy(bifrostName)] : EVERY_MODEL;
    const provider = await this.find(bifrostName);
    if (!provider) throw new ConflictException(NOT_IN_GATEWAY_MESSAGE);
    const keys = await this.bifrostCall(() => this.bifrostService.listProviderKeys(bifrostName));
    const ownKeys = keys.filter((key) => key.id && !isHelmPlaceholder(key));
    if (provider.keyLess || ownKeys.length === 0) throw new ConflictException(NO_KEY_FOR_MODELS_MESSAGE);
    for (const key of ownKeys) {
      await this.bifrostCall(() => this.bifrostService.replaceProviderKey(bifrostName, key.id, { ...key, models }));
    }
  }

  private modelsAlwaysServedBy(bifrostName: string): string[] {
    return bifrostName === TRANSCRIPTION_PROVIDER ? [TRANSCRIPTION_MODEL_ID] : [];
  }

  async replaceConnection(
    current: BifrostProviderSpec,
    edit: ConnectionEdit,
    underLock: (write: () => Promise<void>) => Promise<void>
  ): Promise<void> {
    if (current.kind === 'linked-account') throw new BadRequestException(LINKED_ACCOUNT_SIGNS_IN_MESSAGE);
    const next: BifrostProviderSpec = edit.movesBaseUrl
      ? { ...current, adminTypedBaseUrl: adminTypedBaseUrlFor(current.kind, edit.input) }
      : current;
    const moved = next.adminTypedBaseUrl !== current.adminTypedBaseUrl;

    if (moved) await this.updateInBifrost(next);
    try {
      await this.passConnectionTest(next, edit.key);
      await underLock(async () => {
        const [storedKey] = await this.bifrostCall(() => this.bifrostService.listProviderKeys(current.name));
        const key = bifrostProviderKey({ ...next, models: storedModelsOf(storedKey?.models) }, edit.key);
        await this.bifrostCall(() =>
          storedKey?.id
            ? this.bifrostService.replaceProviderKey(current.name, storedKey.id, key)
            : this.bifrostService.addProviderKey(current.name, key)
        );
      });
    } catch (err) {
      if (moved) await this.restoreInBifrost(current.name, bifrostProviderUpdatePayload(current));
      throw err;
    }
  }

  async remove(bifrostName: string): Promise<void> {
    try {
      await this.bifrostService.deleteProviderConfirmed(bifrostName);
    } catch (err) {
      this.logger.error(`Bifrost provider ${bifrostName} could not be removed: ${(err as Error).message}`);
      throw new BadGatewayException(GATEWAY_KEPT_PROVIDER_MESSAGE);
    }
  }

  private async bifrostCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.logger.warn(`Bifrost call failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
    }
  }

  private connectionTestUrl(spec: BifrostProviderSpec): string {
    if (spec.adminTypedBaseUrl) return `${spec.adminTypedBaseUrl}${spec.format.compatibleEndpoint.connectionTestPath}`;
    const officialApiUrl = this.officialApiUrlOverrides[spec.format.id] ?? spec.format.officialApiUrl;
    return `${officialApiUrl.replace(/\/+$/, '')}${spec.format.connectionTest.path}`;
  }

  private async createInBifrost(draft: NewProviderDraft): Promise<void> {
    try {
      await this.bifrostService.createProvider(bifrostProviderPayload(draft.spec));
    } catch (err) {
      if (err instanceof BifrostApiError && err.status === 409) throw new ConflictException(NAME_TAKEN_MESSAGE);
      if (err instanceof BifrostApiError && err.status === 400) throw new BadRequestException(err.bifrostMessage);
      this.logger.warn(`Bifrost did not create provider ${draft.spec.name}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
    }
  }

  private async updateInBifrost(spec: BifrostProviderSpec): Promise<void> {
    try {
      await this.bifrostService.updateProvider(spec.name, bifrostProviderUpdatePayload(spec));
    } catch (err) {
      if (err instanceof BifrostApiError && err.status === 400) throw new BadRequestException(err.bifrostMessage);
      this.logger.warn(`Bifrost did not update provider ${spec.name}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
    }
  }

  private async restoreInBifrost(bifrostName: string, config: UpdateBifrostProviderRequest): Promise<void> {
    try {
      await this.bifrostService.updateProvider(bifrostName, config);
    } catch (err) {
      this.logger.error(`Bifrost provider ${bifrostName} kept its new connection: ${(err as Error).message}`);
    }
  }

  private async passConnectionTest(spec: BifrostProviderSpec, key: string): Promise<void> {
    const outcome = await testConnection(this.connectionTestUrl(spec), spec.format, key);
    if (!outcome.passed) throw new UnprocessableEntityException(outcome.reason);
  }
}

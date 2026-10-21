import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BifrostService } from '../bifrost/bifrost.service';
import type { BifrostProviderKeySummary, CreateBifrostProviderKeyRequest } from '../bifrost/bifrost.types';
import { BASE_FORMATS, BASE_FORMAT_IDS, type BaseFormatId } from './base-formats';
import { servedModelsOf, standardProviderPayload } from './bifrost-provider-shape';
import { testConnectionWith } from './connection-test';
import { AZURE_PROVIDER } from './model-provider.service';
import { BIFROST_UNREACHABLE_MESSAGE } from './model-provider.types';
import { field } from './request-fields';

const AZURE_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'];
const DEPLOYMENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

const ENTER_ENDPOINT_MESSAGE =
  'Enter the Azure AI Foundry endpoint, such as https://<resource>.services.ai.azure.com or https://<resource>.openai.azure.com';
const CHOOSE_MODELS_MESSAGE = 'Choose at least one model, or choose every model';
const ENTER_KEY_MESSAGE = 'Enter the key';
const CONNECTION_GONE_MESSAGE = 'The model gateway no longer has this Azure connection; delete it and add it again';
const GATEWAY_KEPT_KEY_MESSAGE = 'The model gateway did not remove the Azure key it was asked to remove; try again';

export interface AzureModels {
  models: string[] | null;
  deployments: Record<string, string>;
}

export interface AzureAccess {
  endpoint: string;
  key: string;
}

export type AzureConnection = AzureAccess & AzureModels;

const EVERY_MODEL = ['*'];

function familyOf(model: string): BaseFormatId | undefined {
  return BASE_FORMAT_IDS.find((format) => servedModelsOf(BASE_FORMATS[format]).includes(model));
}

export function formatsOfModels(models: string[] | null): BaseFormatId[] {
  if (!models) return [...BASE_FORMAT_IDS];
  return BASE_FORMAT_IDS.filter((format) => models.some((model) => familyOf(model) === format));
}

function parseEndpoint(input: unknown): string {
  const typed = typeof input === 'string' ? input.trim().replace(/\/+$/, '') : '';
  if (!URL.canParse(typed)) throw new BadRequestException(ENTER_ENDPOINT_MESSAGE);
  const url = new URL(typed);
  const onAzure = AZURE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  if (url.protocol !== 'https:' || !onAzure || url.pathname !== '/' || url.search || url.username) {
    throw new BadRequestException(ENTER_ENDPOINT_MESSAGE);
  }
  return url.origin;
}

function parseModels(input: unknown): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException(CHOOSE_MODELS_MESSAGE);
  const models = [...new Set(input)];
  for (const model of models) {
    if (typeof model !== 'string' || !familyOf(model)) {
      throw new BadRequestException(`${String(model)} is not a model of the catalog`);
    }
  }
  return models as string[];
}

function parseDeployments(input: unknown, models: string[] | null): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('deployments must be an object');
  const deployments: Record<string, string> = {};
  for (const [model, deployment] of Object.entries(input)) {
    const served = models ? models.includes(model) : familyOf(model) !== undefined;
    if (!served) throw new BadRequestException(`${model} is not one of the models it serves`);
    if (typeof deployment !== 'string' || !DEPLOYMENT_NAME.test(deployment)) {
      throw new BadRequestException(`Enter the Azure deployment name for ${model}`);
    }
    if (deployment !== model) deployments[model] = deployment;
  }
  return deployments;
}

function aliasesOf(deployments: Record<string, string>): CreateBifrostProviderKeyRequest['aliases'] {
  const entries = Object.entries(deployments);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([model, deployment]) => [
      model,
      familyOf(model) === 'anthropic' && !deployment.toLowerCase().includes('claude')
        ? { model_id: deployment, model_family: 'anthropic' }
        : deployment,
    ])
  );
}

@Injectable()
export class AzureConnectionsService {
  private readonly logger = new Logger(AzureConnectionsService.name);

  constructor(private readonly bifrostService: BifrostService) {}

  connectionOf(input: unknown): AzureConnection {
    return { ...this.accessOf(input), ...this.modelsOf(input) };
  }

  accessOf(input: unknown): AzureAccess {
    const endpoint = parseEndpoint(field(input, 'endpoint'));
    const key = field(input, 'key');
    if (typeof key !== 'string' || key.trim() === '') throw new BadRequestException(ENTER_KEY_MESSAGE);
    return { endpoint, key: key.trim() };
  }

  modelsOf(input: unknown): AzureModels {
    const models = parseModels(field(input, 'models'));
    return { models, deployments: parseDeployments(field(input, 'deployments'), models) };
  }

  async find(name: string): Promise<BifrostProviderKeySummary | undefined> {
    if (!(await this.bifrostCall(() => this.bifrostService.hasProvider(AZURE_PROVIDER)))) return undefined;
    const keys = await this.bifrostCall(() => this.bifrostService.listProviderKeys(AZURE_PROVIDER));
    return keys.find((key) => key.name === name);
  }

  async create(name: string, connection: AzureConnection, persist: () => Promise<void>): Promise<void> {
    await this.passConnectionTest(connection);
    await this.ensureAzureProvider();
    if (await this.find(name)) throw new ConflictException('That name is taken; choose another');
    await this.bifrostCall(() => this.bifrostService.addProviderKey(AZURE_PROVIDER, this.keyPayload(name, connection)));
    try {
      await persist();
    } catch (err) {
      await this.remove(name).catch(() => undefined);
      throw err;
    }
  }

  async replaceAccess(name: string, access: AzureAccess): Promise<void> {
    const stored = await this.find(name);
    if (!stored) throw new ConflictException(CONNECTION_GONE_MESSAGE);
    await this.passConnectionTest(access);
    await this.bifrostCall(() =>
      this.bifrostService.replaceProviderKey(AZURE_PROVIDER, stored.id, {
        ...stored,
        value: { value: access.key, type: 'plain_text' },
        azure_key_config: { endpoint: { value: access.endpoint, type: 'plain_text' } },
      })
    );
  }

  async setModels(name: string, choice: AzureModels): Promise<() => Promise<void>> {
    const stored = await this.find(name);
    if (!stored) throw new ConflictException(CONNECTION_GONE_MESSAGE);
    await this.bifrostCall(() =>
      this.bifrostService.replaceProviderKey(AZURE_PROVIDER, stored.id, {
        ...stored,
        models: choice.models ?? EVERY_MODEL,
        aliases: aliasesOf(choice.deployments) ?? {},
      })
    );
    return () =>
      this.bifrostService.replaceProviderKey(AZURE_PROVIDER, stored.id, stored).catch((err: Error) => {
        this.logger.error(`Azure key ${name} could not be put back after a failed change: ${err.message}`);
      });
  }

  async remove(name: string): Promise<void> {
    const stored = await this.find(name);
    if (!stored) return;
    try {
      await this.bifrostService.deleteProviderKey(AZURE_PROVIDER, stored.id);
    } catch (err) {
      this.logger.error(`Azure key ${name} could not be removed: ${(err as Error).message}`);
      throw new BadGatewayException(GATEWAY_KEPT_KEY_MESSAGE);
    }
  }

  private keyPayload(name: string, connection: AzureConnection): CreateBifrostProviderKeyRequest {
    const aliases = aliasesOf(connection.deployments);
    return {
      name,
      value: { value: connection.key, type: 'plain_text' },
      models: connection.models ?? EVERY_MODEL,
      weight: 1,
      enabled: true,
      azure_key_config: { endpoint: { value: connection.endpoint, type: 'plain_text' } },
      ...(aliases ? { aliases } : {}),
    };
  }

  private async ensureAzureProvider(): Promise<void> {
    if (await this.bifrostCall(() => this.bifrostService.hasProvider(AZURE_PROVIDER))) return;
    await this.bifrostCall(() => this.bifrostService.createProvider(standardProviderPayload(AZURE_PROVIDER)));
  }

  async test(access: AzureAccess): Promise<void> {
    await this.passConnectionTest(access);
  }

  private async passConnectionTest(access: AzureAccess): Promise<void> {
    const outcome = await testConnectionWith(`${access.endpoint}/openai/v1/models`, { 'api-key': access.key });
    if (!outcome.passed) throw new UnprocessableEntityException(outcome.reason);
  }

  private async bifrostCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.logger.warn(`Bifrost call failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(BIFROST_UNREACHABLE_MESSAGE);
    }
  }
}

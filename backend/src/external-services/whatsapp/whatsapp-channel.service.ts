import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { errorMessage } from '../../common/error-message';
import crypto from 'crypto';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import type { ExternalServiceDefinition } from '../platform/external-service-definition';
import {
  ExternalServiceConfigStore,
  type ExternalServiceResourceRecord,
} from '../platform/external-service-config-store.service';
import {
  configReferencesChannel,
  parseChannelResource,
  parseEnvironmentConfig,
  type WhatsappChannelResource,
} from './whatsapp-config-doc';
import { WhapiClient, type WhapiWebhookRegistration } from './whapi.client';
import type {
  AllowlistWhatsappChatDto,
  CreateWhatsappChannelDto,
  UpdateWhatsappChannelDto,
  WhatsappAvailableChannelResponse,
  WhatsappChannelResponse,
  WhatsappChatOption,
  WhatsappEnvironmentChannelResponse,
  WhatsappWebhookState,
  WhatsappWebhookStatusResponse,
} from './whatsapp.types';
import { timingSafeStringEqual } from '../../common/secret-crypto';
import { WHATSAPP_SERVICE_NAME, WHATSAPP_WEBHOOK_PATH } from './whatsapp.constants';

const CHANNEL_ID_MAX_LENGTH = 120;
const RECORD_ID_MAX_LENGTH = 120;
const LABEL_MAX_LENGTH = 120;
const CHAT_ID_MAX_LENGTH = 200;
const CHAT_NAME_MAX_LENGTH = 200;
const API_TOKEN_MAX_LENGTH = 500;
const WEBHOOK_SECRET_BYTES = 32;
const TOKEN_PREVIEW_LENGTH = 4;

const CHAT_ID_PATTERN = /^[^\s@]+@[^\s@]+$/;

@Injectable()
export class WhatsappChannelService {
  private readonly logger = new Logger(WhatsappChannelService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly whapiClient: WhapiClient,
    private readonly store: ExternalServiceConfigStore
  ) {}

  async listAvailableChannels(): Promise<WhatsappAvailableChannelResponse[]> {
    const resources = await this.store.listResources(WHATSAPP_SERVICE_NAME);

    return resources
      .map((record) => ({
        channelId: record.resourceKey,
        label: parseChannelResource(record.value)?.label ?? null,
      }))
      .toSorted((a, b) => (a.label ?? a.channelId).localeCompare(b.label ?? b.channelId));
  }

  async listEnvironmentChats(projectEnvironmentId: string, channelId: string): Promise<WhatsappChatOption[]> {
    await this.requireEnvironment(projectEnvironmentId);

    return this.listChats(channelId);
  }

  async listChannels(): Promise<WhatsappChannelResponse[]> {
    const resources = await this.store.listResources(WHATSAPP_SERVICE_NAME);
    const configs = await this.store.listConfigs(WHATSAPP_SERVICE_NAME);

    return resources
      .map((record) => {
        const resource = parseChannelResource(record.value);
        if (!resource) return null;
        const referencedEnvironmentCount = configs.filter((config) =>
          configReferencesChannel(config.value, record.resourceKey)
        ).length;
        return this.toChannelResponse(record.resourceKey, resource, {
          referencedEnvironmentCount,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      })
      .filter((channel): channel is WhatsappChannelResponse => channel !== null)
      .toSorted((a, b) => a.channelId.localeCompare(b.channelId));
  }

  async createChannel(dto: CreateWhatsappChannelDto): Promise<WhatsappChannelResponse> {
    const channelId = requireText(dto.channelId, 'channelId', CHANNEL_ID_MAX_LENGTH);
    const apiToken = requireText(dto.apiToken, 'apiToken', API_TOKEN_MAX_LENGTH);
    const label = optionalText(dto.label, 'label', LABEL_MAX_LENGTH);

    if (await this.store.getResource(WHATSAPP_SERVICE_NAME, channelId)) {
      throw new ConflictException(`Channel ${channelId} is already registered`);
    }

    const resource: WhatsappChannelResource = { apiToken, webhookSecret: generateWebhookSecret(), label };
    await this.store.upsertResource(WHATSAPP_SERVICE_NAME, channelId, resource);

    this.logger.log(`Registered Whapi channel ${channelId}`);

    await this.pushWebhookBestEffort(channelId, resource);

    const now = new Date();
    return this.toChannelResponse(channelId, resource, {
      referencedEnvironmentCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateChannel(channelId: string, dto: UpdateWhatsappChannelDto): Promise<WhatsappChannelResponse> {
    const { record, resource: existing } = await this.findChannelRecord(channelId);

    const apiToken =
      dto.apiToken === undefined ? undefined : requireText(dto.apiToken, 'apiToken', API_TOKEN_MAX_LENGTH);
    const label = dto.label === undefined ? undefined : optionalText(dto.label, 'label', LABEL_MAX_LENGTH);

    const updated: WhatsappChannelResource = {
      apiToken: apiToken ?? existing.apiToken,
      webhookSecret: existing.webhookSecret,
      label: label === undefined ? existing.label : label,
    };

    if (updated.apiToken !== existing.apiToken) {
      await this.pushWebhook(updated);
    }

    await this.store.upsertResource(WHATSAPP_SERVICE_NAME, channelId, updated);

    return this.savedChannelResponse(channelId, updated, record.createdAt);
  }

  async deleteChannel(definition: ExternalServiceDefinition, channelId: string): Promise<void> {
    const deleted = await this.store.deleteResource(definition, channelId);
    if (!deleted) throw new NotFoundException('Channel not found');

    this.logger.log(`Deleted Whapi channel ${channelId}`);
  }

  async rotateWebhookSecret(channelId: string): Promise<WhatsappChannelResponse> {
    const { record, resource: existing } = await this.findChannelRecord(channelId);

    const rotated: WhatsappChannelResource = { ...existing, webhookSecret: generateWebhookSecret() };

    await this.pushWebhook(rotated);
    await this.store.upsertResource(WHATSAPP_SERVICE_NAME, channelId, rotated);

    this.logger.log(`Rotated the webhook secret of Whapi channel ${channelId}`);

    return this.savedChannelResponse(channelId, rotated, record.createdAt);
  }

  async listEnvironmentChannels(projectEnvironmentId: string): Promise<WhatsappEnvironmentChannelResponse[]> {
    await this.requireEnvironment(projectEnvironmentId);

    const config = parseEnvironmentConfig(await this.store.getConfig(WHATSAPP_SERVICE_NAME, projectEnvironmentId));
    if (config.channels.length === 0) return [];

    const resources = await this.store.listResources(WHATSAPP_SERVICE_NAME);
    const labelByChannelId = new Map(
      resources.map((record) => [record.resourceKey, parseChannelResource(record.value)?.label ?? null])
    );

    return config.channels
      .map((channel) => ({
        channelId: channel.channelId,
        label: labelByChannelId.get(channel.channelId) ?? null,
        registered: labelByChannelId.has(channel.channelId),
        allowedChats: channel.allowedChats.map((chat) => ({ chatId: chat.chatId, chatName: chat.chatName })),
      }))
      .toSorted((a, b) => (a.label ?? a.channelId).localeCompare(b.label ?? b.channelId));
  }

  async allowlistChat(
    projectEnvironmentId: string,
    channelId: string,
    dto: AllowlistWhatsappChatDto
  ): Promise<WhatsappEnvironmentChannelResponse[]> {
    await this.requireEnvironment(projectEnvironmentId);
    await this.findResource(channelId);

    const chatId = requireChatId(dto.chatId);
    const chatName = optionalText(dto.chatName, 'chatName', CHAT_NAME_MAX_LENGTH);

    const config = parseEnvironmentConfig(await this.store.getConfig(WHATSAPP_SERVICE_NAME, projectEnvironmentId));
    const channel = config.channels.find((entry) => entry.channelId === channelId);

    if (channel?.allowedChats.some((chat) => chat.chatId === chatId)) {
      throw new ConflictException('That chat is already allowlisted on this channel');
    }

    if (channel) {
      channel.allowedChats.push({ chatId, chatName });
    } else {
      config.channels.push({ channelId, allowedChats: [{ chatId, chatName }] });
    }

    await this.store.upsertConfig(WHATSAPP_SERVICE_NAME, projectEnvironmentId, config);
    this.logger.log(`Allowlisted chat ${chatId} on channel ${channelId} for environment ${projectEnvironmentId}`);

    return this.listEnvironmentChannels(projectEnvironmentId);
  }

  async removeChat(
    projectEnvironmentId: string,
    channelId: string,
    chatId: string
  ): Promise<WhatsappEnvironmentChannelResponse[]> {
    const config = parseEnvironmentConfig(await this.store.getConfig(WHATSAPP_SERVICE_NAME, projectEnvironmentId));
    const channel = config.channels.find((entry) => entry.channelId === channelId);
    if (!channel || !channel.allowedChats.some((chat) => chat.chatId === chatId)) {
      throw new NotFoundException('That chat is not allowlisted on this channel');
    }

    channel.allowedChats = channel.allowedChats.filter((chat) => chat.chatId !== chatId);
    config.channels = config.channels.filter((entry) => entry.allowedChats.length > 0);

    await this.store.upsertConfig(WHATSAPP_SERVICE_NAME, projectEnvironmentId, config);

    return this.listEnvironmentChannels(projectEnvironmentId);
  }

  async listChats(channelId: string): Promise<WhatsappChatOption[]> {
    const resource = await this.findResource(channelId);
    return this.whapiClient.listChats(resource.apiToken);
  }

  async webhookStatus(channelId: string): Promise<WhatsappWebhookStatusResponse> {
    const resource = await this.findResource(channelId);
    const expectedUrl = this.defaultWebhookUrl();
    const registrations = await this.whapiClient.listWebhooks(resource.apiToken);

    const matchingUrl = registrations.find((registration) => registration.url === expectedUrl);
    const candidate = matchingUrl ?? registrations[0] ?? null;

    return {
      state: this.webhookState(resource, expectedUrl, matchingUrl ?? null, candidate),
      configuredUrl: candidate?.url ?? null,
      expectedUrl,
    };
  }

  private webhookState(
    resource: WhatsappChannelResource,
    expectedUrl: string,
    matchingUrl: WhapiWebhookRegistration | null,
    candidate: WhapiWebhookRegistration | null
  ): WhatsappWebhookState {
    if (!candidate) return 'not-configured';
    if (!matchingUrl || !expectedUrl) return 'stale-url';
    if (!matchingUrl.secret || !timingSafeStringEqual(resource.webhookSecret, matchingUrl.secret)) {
      return 'stale-secret';
    }
    if (!matchingUrl.handlesIncomingMessages) return 'missing-event';
    return 'in-sync';
  }

  private async pushWebhook(resource: WhatsappChannelResource): Promise<void> {
    const webhookUrl = this.defaultWebhookUrl();
    if (!webhookUrl) return;

    await this.whapiClient.configureWebhook(resource.apiToken, webhookUrl, resource.webhookSecret);
  }

  private async pushWebhookBestEffort(channelId: string, resource: WhatsappChannelResource): Promise<void> {
    try {
      await this.pushWebhook(resource);
    } catch (err) {
      this.logger.warn(
        `Registered Whapi channel ${channelId} but could not configure its webhook: ${errorMessage(err)}`
      );
    }
  }

  private defaultWebhookUrl(): string {
    const base = this.configService.get<string>('externalServicesWebhookBaseUrl', '').trim().replace(/\/+$/, '');
    return base ? `${base}${WHATSAPP_WEBHOOK_PATH}` : '';
  }

  private async findChannelRecord(
    channelId: string
  ): Promise<{ record: ExternalServiceResourceRecord; resource: WhatsappChannelResource }> {
    const records = await this.store.listResources(WHATSAPP_SERVICE_NAME);
    const record = records.find((candidate) => candidate.resourceKey === channelId);
    const resource = record ? parseChannelResource(record.value) : null;
    if (!record || !resource) throw new NotFoundException('Channel not found');
    return { record, resource };
  }

  private async savedChannelResponse(
    channelId: string,
    resource: WhatsappChannelResource,
    createdAt: Date
  ): Promise<WhatsappChannelResponse> {
    const configs = await this.store.listConfigs(WHATSAPP_SERVICE_NAME);
    const referencedEnvironmentCount = configs.filter((config) =>
      configReferencesChannel(config.value, channelId)
    ).length;

    return this.toChannelResponse(channelId, resource, {
      referencedEnvironmentCount,
      createdAt,
      updatedAt: new Date(),
    });
  }

  private async findResource(channelId: string): Promise<WhatsappChannelResource> {
    const value = await this.store.getResource(WHATSAPP_SERVICE_NAME, channelId);
    const resource = value === null ? null : parseChannelResource(value);
    if (!resource) throw new NotFoundException('Channel not found');
    return resource;
  }

  private async requireEnvironment(projectEnvironmentId: string): Promise<void> {
    const id = requireText(projectEnvironmentId, 'projectEnvironmentId', RECORD_ID_MAX_LENGTH);

    const [row] = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, id));

    if (!row) throw new BadRequestException(`Unknown environment ${id}`);
  }

  private toChannelResponse(
    channelId: string,
    resource: WhatsappChannelResource,
    context: { referencedEnvironmentCount: number; createdAt: Date; updatedAt: Date }
  ): WhatsappChannelResponse {
    return {
      channelId,
      label: resource.label,
      apiTokenPreview: tokenPreview(resource.apiToken),
      webhookUrl: this.defaultWebhookUrl(),
      referencedEnvironmentCount: context.referencedEnvironmentCount,
      createdAt: context.createdAt.toISOString(),
      updatedAt: context.updatedAt.toISOString(),
    };
  }
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
}

function tokenPreview(apiToken: string): string {
  return `…${apiToken.slice(-TOKEN_PREVIEW_LENGTH)}`;
}

function requireText(value: string | undefined, field: string, maxLength: number): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new BadRequestException(`${field} is required`);
  if (trimmed.length > maxLength) throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function optionalText(value: string | null | undefined, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function requireChatId(value: string | undefined): string {
  const chatId = requireText(value, 'chatId', CHAT_ID_MAX_LENGTH);
  if (!CHAT_ID_PATTERN.test(chatId)) {
    throw new BadRequestException(
      `Invalid chat id "${chatId}", expected a Whapi chat id such as 1234567890@s.whatsapp.net or 1234567890@g.us`
    );
  }
  return chatId;
}

import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../common/error-message';
import { environmentIdParam } from '../http/dispatch-request';
import { ExternalServiceConfigStore } from '../platform/external-service-config-store.service';
import type {
  AdminRouteContext,
  ExternalServiceDefinition,
  JsonValue,
  PublishCarryContext,
  ServiceRouteTables,
  StoredAttachment,
  StoredMessage,
  WebhookRequest,
  WebhookVerification,
} from '../platform/external-service-definition';
import { timingSafeStringEqual } from '../../common/secret-crypto';
import { WhatsappChannelService } from './whatsapp-channel.service';
import {
  configReferencesChannel,
  parseChannelResource,
  parseEnvironmentConfig,
  type WhatsappChannelResource,
} from './whatsapp-config-doc';
import { WhapiClient } from './whapi.client';
import { WHATSAPP_MEDIA_TYPES, WHATSAPP_SERVICE_NAME, WHATSAPP_WEBHOOK_SECRET_HEADER } from './whatsapp.constants';

type JsonObject = { [key: string]: JsonValue };

interface WhatsappMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  payload: JsonObject;
}

interface WhatsappMedia {
  id: string;
  contentType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  caption: string | null;
  link: string | null;
}

interface MatchedChannel {
  channelId: string;
  resource: WhatsappChannelResource;
}

@Injectable()
export class WhatsappDefinition implements ExternalServiceDefinition {
  readonly serviceName = WHATSAPP_SERVICE_NAME;
  readonly displayName = 'WhatsApp';
  readonly unroutableResponse = 'accept' as const;

  readonly routes: ServiceRouteTables = {
    admin: [
      {
        method: 'GET',
        path: 'channels',
        handler: (): Promise<JsonValue> => this.channelService.listChannels(),
      },
      {
        method: 'POST',
        path: 'channels',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.createChannel({
            channelId: textField(context.body, 'channelId'),
            apiToken: textField(context.body, 'apiToken'),
            label: nullableTextField(context.body, 'label'),
          }),
      },
      {
        method: 'PATCH',
        path: 'channels/:channelId',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.updateChannel(channelIdParam(context), {
            apiToken: textField(context.body, 'apiToken'),
            label: nullableTextField(context.body, 'label'),
          }),
      },
      {
        method: 'DELETE',
        path: 'channels/:channelId',
        handler: async (context: AdminRouteContext): Promise<JsonValue> => {
          await this.channelService.deleteChannel(this, channelIdParam(context));
          return { ok: true };
        },
      },
      {
        method: 'POST',
        path: 'channels/:channelId/rotate-secret',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.rotateWebhookSecret(channelIdParam(context)),
      },
      {
        method: 'GET',
        path: 'channels/:channelId/webhook-status',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.webhookStatus(channelIdParam(context)),
      },
      {
        method: 'GET',
        path: 'channels/:channelId/chats',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.listChats(channelIdParam(context)),
      },
      {
        method: 'GET',
        path: 'environments/:projectEnvironmentId/channels',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.listEnvironmentChannels(environmentIdParam(context)),
      },
      {
        method: 'GET',
        path: 'environments/:projectEnvironmentId/available-channels',
        handler: (): Promise<JsonValue> => this.channelService.listAvailableChannels(),
      },
      {
        method: 'GET',
        path: 'environments/:projectEnvironmentId/channels/:channelId/chats',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.listEnvironmentChats(environmentIdParam(context), channelIdParam(context)),
      },
      {
        method: 'POST',
        path: 'environments/:projectEnvironmentId/channels/:channelId/chats',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.allowlistChat(environmentIdParam(context), channelIdParam(context), {
            chatId: textField(context.body, 'chatId'),
            chatName: nullableTextField(context.body, 'chatName'),
          }),
      },
      {
        method: 'DELETE',
        path: 'environments/:projectEnvironmentId/channels/:channelId/chats',
        handler: (context: AdminRouteContext): Promise<JsonValue> =>
          this.channelService.removeChat(
            environmentIdParam(context),
            channelIdParam(context),
            context.query.chatId ?? ''
          ),
      },
    ],
  };

  private readonly logger = new Logger(WhatsappDefinition.name);
  private readonly matchedByRequest = new WeakMap<WebhookRequest, Promise<MatchedChannel | null>>();

  constructor(
    private readonly store: ExternalServiceConfigStore,
    private readonly whapiClient: WhapiClient,
    private readonly channelService: WhatsappChannelService
  ) {}

  async identity(projectEnvironmentId: string): Promise<JsonValue> {
    const config = parseEnvironmentConfig(await this.store.getConfig(this.serviceName, projectEnvironmentId));
    if (config.channels.length === 0) return { channels: [] };

    const resources = await this.store.listResources(this.serviceName);
    const labelByChannelId = new Map(
      resources.map((record) => [record.resourceKey, parseChannelResource(record.value)?.label ?? null])
    );

    return {
      channels: config.channels.map((channel) => ({
        channelId: channel.channelId,
        label: labelByChannelId.get(channel.channelId) ?? null,
        allowedChats: channel.allowedChats.map((chat) => ({ chatId: chat.chatId, chatName: chat.chatName })),
      })),
    };
  }

  async verify(request: WebhookRequest): Promise<WebhookVerification> {
    const matched = await this.matchedChannel(request);
    if (!matched) {
      return { verified: false, reason: `Unknown channel_id or invalid ${WHATSAPP_WEBHOOK_SECRET_HEADER}` };
    }
    return { verified: true };
  }

  extractRoutingKeys(request: WebhookRequest): string[] {
    return [...new Set(messagesOf(request).map((message) => message.chatId))];
  }

  async resolveEnvironments(routingKey: string, request: WebhookRequest): Promise<string[]> {
    const matched = await this.matchedChannel(request);
    if (!matched) return [];

    const configs = await this.store.listConfigs(this.serviceName);
    const projectEnvironmentIds = configs
      .filter((config) =>
        parseEnvironmentConfig(config.value).channels.some(
          (channel) =>
            channel.channelId === matched.channelId && channel.allowedChats.some((chat) => chat.chatId === routingKey)
        )
      )
      .map((config) => config.projectEnvironmentId);

    if (projectEnvironmentIds.length === 0) {
      this.logger.log(`WhatsApp chat ${routingKey} is not allowlisted, dropping its messages`);
    }

    return projectEnvironmentIds;
  }

  async carryOnPublish(context: PublishCarryContext): Promise<void> {
    const sourceConfig = await this.store.getConfig(this.serviceName, context.sourceEnvironmentId);
    if (sourceConfig === null) return;

    await this.store.upsertConfig(this.serviceName, context.targetEnvironmentId, sourceConfig);
    this.logger.log(`Carried WhatsApp chat wiring to environment ${context.targetEnvironmentId}`);
  }

  configReferencesResource(config: JsonValue, resourceKey: string): boolean {
    return configReferencesChannel(config, resourceKey);
  }

  async buildRows(request: WebhookRequest, routingKey: string): Promise<StoredMessage[]> {
    const matched = await this.matchedChannel(request);
    const rows: StoredMessage[] = [];

    for (const message of messagesOf(request)) {
      if (message.chatId !== routingKey) continue;
      rows.push(await this.buildRow(message, matched?.channelId ?? '', matched?.resource.apiToken ?? null));
    }

    return rows;
  }

  private async buildRow(message: WhatsappMessage, channelId: string, apiToken: string | null): Promise<StoredMessage> {
    const { payload } = message;
    const type = asString(payload.type) ?? 'unknown';
    const media = mediaOf(payload, type);
    const content = media ? await this.fetchMediaContent(media, apiToken) : null;

    if (media === null && WHATSAPP_MEDIA_TYPES.has(type)) {
      this.logger.warn(
        `WhatsApp message ${message.id} has media type "${type}" but no "${type}" object in its payload; stored with no attachment`
      );
    }

    return {
      providerMessageId: message.id,
      rawPayload: JSON.stringify(payload),
      routingKey: message.chatId,
      sender: asString(payload.from),
      textBody: textBodyOf(payload) ?? media?.caption ?? null,
      payload: {
        channel_id: channelId,
        chat_name: asString(payload.chat_name),
        from_me: message.fromMe,
        from_name: asString(payload.from_name),
        type,
        sent_at: sentAtOf(payload),
        source: asString(payload.source),
        caption: media?.caption ?? null,
        media_id: media?.id ?? null,
        media_fetch_failed: media !== null && content === null,
      },
      attachments: media ? [attachmentOf(media, content)] : [],
    };
  }

  private async fetchMediaContent(media: WhatsappMedia, apiToken: string | null): Promise<Buffer | null> {
    const failures: string[] = [];

    if (apiToken) {
      try {
        return await this.whapiClient.fetchMedia(apiToken, media.id);
      } catch (err) {
        failures.push(errorMessage(err));
      }
    }

    if (media.link) {
      try {
        return await this.whapiClient.fetchMediaLink(media.link);
      } catch (err) {
        failures.push(errorMessage(err));
      }
    }

    this.logger.error(
      `Could not fetch WhatsApp media ${media.id}; its attachment row is stored with content NULL: ${failures.join('; ') || 'no channel token and no auto_download link'}`
    );
    return null;
  }

  private matchedChannel(request: WebhookRequest): Promise<MatchedChannel | null> {
    const cached = this.matchedByRequest.get(request);
    if (cached) return cached;

    const pending = this.resolveMatchedChannel(request);
    this.matchedByRequest.set(request, pending);
    return pending;
  }

  private async resolveMatchedChannel(request: WebhookRequest): Promise<MatchedChannel | null> {
    const channelId = channelIdOf(request);
    const secret = request.headers[WHATSAPP_WEBHOOK_SECRET_HEADER.toLowerCase()] ?? '';
    if (!channelId || !secret) return null;

    const value = await this.store.getResource(this.serviceName, channelId);
    const resource = value === null ? null : parseChannelResource(value);
    if (!resource || !timingSafeStringEqual(resource.webhookSecret, secret)) return null;

    return { channelId, resource };
  }
}

function attachmentOf(media: WhatsappMedia, content: Buffer | null): StoredAttachment {
  return {
    filename: media.filename,
    contentType: media.contentType,
    sizeBytes: content?.byteLength ?? media.sizeBytes ?? 0,
    content,
  };
}

function channelIdParam(context: AdminRouteContext): string {
  return context.params.channelId ?? '';
}

function textField(body: JsonValue, key: string): string | undefined {
  const value = asObject(body)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function nullableTextField(body: JsonValue, key: string): string | null | undefined {
  const value = asObject(body)?.[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function channelIdOf(request: WebhookRequest): string | null {
  const body = asObject(request.json);
  return body ? asString(body.channel_id) : null;
}

function messagesOf(request: WebhookRequest): WhatsappMessage[] {
  const body = asObject(request.json);
  const messages = body ? body.messages : null;
  if (!Array.isArray(messages)) return [];

  const collected: WhatsappMessage[] = [];
  for (const entry of messages) {
    const payload = asObject(entry);
    if (!payload) continue;

    const id = asString(payload.id);
    const chatId = asString(payload.chat_id);
    if (!id || !chatId) continue;

    collected.push({ id, chatId, fromMe: payload.from_me === true, payload });
  }

  return collected;
}

function mediaOf(payload: JsonObject, type: string): WhatsappMedia | null {
  const media = asObject(payload[type]);
  const id = media ? asString(media.id) : null;
  if (!media || !id) return null;

  return {
    id,
    contentType: asString(media.mime_type),
    filename: asString(media.filename),
    sizeBytes: asNumber(media.file_size),
    caption: asString(media.caption),
    link: asString(media.link),
  };
}

function textBodyOf(payload: JsonObject): string | null {
  const text = asObject(payload.text);
  return text ? asString(text.body) : null;
}

function sentAtOf(payload: JsonObject): string | null {
  const timestamp = asNumber(payload.timestamp);
  return timestamp === null ? null : new Date(timestamp * 1000).toISOString();
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

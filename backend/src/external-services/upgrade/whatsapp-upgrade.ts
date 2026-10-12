import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceConfig, externalServiceProjectConfigs, externalServiceResource } from '../../../db/schema';
import type { JsonObject, JsonValue } from '../../common/json';
import { SecretSealer, SecretUnreadableError } from '../../sealing/secret-sealer';
import { isListItem, PLATFORM_OWNER } from '../configuration/configuration-values';
import { newListItemId } from '../configuration/form-save';
import { InvalidConfigurationError } from '../configuration/invalid-configuration.error';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import type { Transaction } from '../configuration/transaction';
import type { TolerantRead } from '../configuration/tolerant-read';
import { ServiceSkillReach } from '../knowledge/service-skill-reach';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';

export const WHATSAPP_SERVICE = 'whatsapp';

const RECEIVED_EVENT = 'message.received';

interface ImportedNumber {
  channelId: string;
  label: string;
  apiToken: string;
  webhookSecret: string;
}

interface V1Chat {
  chatId: string;
  chatName: string | null;
}

interface V1Wiring {
  channelId: string;
  chats: V1Chat[];
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function asText(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function v1WiringOf(value: JsonValue): V1Wiring[] {
  const channels = asObject(value)?.channels;
  if (!Array.isArray(channels)) return [];
  return channels.flatMap((entry) => {
    const channel = asObject(entry);
    const channelId = asText(channel?.channelId);
    if (!channel || !channelId) return [];
    const chats = (Array.isArray(channel.allowedChats) ? channel.allowedChats : []).flatMap((chat) => {
      const chatId = asText(asObject(chat)?.chatId);
      return chatId ? [{ chatId, chatName: asText(asObject(chat)?.chatName) }] : [];
    });
    return [{ channelId, chats }];
  });
}

function itemIdsByChannelId(written: TolerantRead): Map<string, string> {
  const items = Array.isArray(written.values.channels) ? written.values.channels : [];
  return new Map(
    items.filter(isListItem).flatMap((item) => (typeof item.channelId === 'string' ? [[item.channelId, item.id]] : []))
  );
}

function projectConfigurationOf(wiring: V1Wiring[], itemIds: Map<string, string>): JsonObject | null {
  const channels = wiring.flatMap((channel) => {
    const item = itemIds.get(channel.channelId);
    if (!item || channel.chats.length === 0) return [];
    return [{ id: newListItemId(), channel: item, chats: [...new Set(channel.chats.map((chat) => chat.chatId))] }];
  });
  if (channels.length === 0) return null;
  const chatNames = Object.fromEntries(
    wiring
      .filter((channel) => itemIds.has(channel.channelId))
      .flatMap((channel) => channel.chats.flatMap((chat) => (chat.chatName ? [[chat.chatId, chat.chatName]] : [])))
  );
  return {
    channels,
    operations: {},
    receive: { [RECEIVED_EVENT]: true },
    _labels: Object.keys(chatNames).length > 0 ? { chats: chatNames } : {},
  };
}

// TODO: remove in the release after External Services v2 ships: one-time v1 import, a no-op once every deployment has booted it
@Injectable()
export class WhatsappUpgrade implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsappUpgrade.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly sealer: SecretSealer,
    private readonly config: ConfigService,
    private readonly serviceSkillReach: ServiceSkillReach
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const service = this.registry.bySlug(WHATSAPP_SERVICE);
    if (!service) return;
    const numbers = await this.v1Numbers();
    const apiUrl = this.config.get<string>('whapiApiUrl', '').trim();
    const apiUrlField = valueFieldsOf(service.manifest.serviceForm ?? []).find((field) => field.key === 'apiUrl');
    const apiUrlDefault = apiUrlField && 'default' in apiUrlField ? apiUrlField.default : undefined;
    const customApiUrl = apiUrl !== '' && apiUrl !== apiUrlDefault;
    if (numbers.length === 0 && !customApiUrl) return;

    try {
      await this.importOnce(service, { ...(customApiUrl ? { apiUrl } : {}), channels: numbers });
    } catch (error) {
      if (!(error instanceof InvalidConfigurationError) || !customApiUrl) throw error;
      this.logger.error(
        `WHAPI_API_URL does not fit the ${WHATSAPP_SERVICE} Service form (${error.message}); imported the numbers with the default API URL`
      );
      await this.importOnce(service, { channels: numbers });
    }
  }

  private async importOnce(
    service: RegisteredService,
    values: { apiUrl?: string; channels: ImportedNumber[] }
  ): Promise<void> {
    const wrote = await this.serviceConfigurations.startWith(service, PLATFORM_OWNER, values, (tx, written) =>
      this.importProjectConfigurations(tx, service, written)
    );
    if (wrote) {
      this.logger.log(
        `Imported ${values.channels.length} WhatsApp number(s) into the ${WHATSAPP_SERVICE} Service configuration`
      );
      await this.serviceSkillReach.layAndReach(service);
    }
  }

  private async v1Numbers(): Promise<ImportedNumber[]> {
    const rows = await db
      .select({ channelId: externalServiceResource.resourceKey, value: externalServiceResource.value })
      .from(externalServiceResource)
      .where(eq(externalServiceResource.service, WHATSAPP_SERVICE));
    return rows.flatMap((row) => {
      let opened: JsonValue;
      try {
        opened = this.sealer.openUnplaced(row.value, `v1 WhatsApp channel ${row.channelId}`);
      } catch (error) {
        if (!(error instanceof SecretUnreadableError)) throw error;
        this.logger.error(`Skipped v1 WhatsApp channel ${row.channelId}: its stored value cannot be opened`);
        return [];
      }
      const resource = asObject(opened);
      const apiToken = asText(resource?.apiToken);
      const webhookSecret = asText(resource?.webhookSecret);
      if (!apiToken || !webhookSecret) {
        this.logger.error(`Skipped v1 WhatsApp channel ${row.channelId}: it has no API token or webhook secret`);
        return [];
      }
      return [{ channelId: row.channelId, label: asText(resource?.label) ?? row.channelId, apiToken, webhookSecret }];
    });
  }

  private async importProjectConfigurations(
    tx: Transaction,
    service: RegisteredService,
    written: TolerantRead
  ): Promise<void> {
    const itemIds = itemIdsByChannelId(written);
    const rows = await tx
      .select({ projectEnvironmentId: externalServiceConfig.projectEnvironmentId, value: externalServiceConfig.value })
      .from(externalServiceConfig)
      .where(eq(externalServiceConfig.service, WHATSAPP_SERVICE));
    let dropped = 0;
    for (const row of rows) {
      const values = projectConfigurationOf(v1WiringOf(row.value), itemIds);
      if (!values) {
        dropped++;
        continue;
      }
      await tx
        .insert(externalServiceProjectConfigs)
        .values({
          id: crypto.randomUUID(),
          externalServiceId: service.id,
          projectEnvironmentId: row.projectEnvironmentId,
          values,
        })
        .onConflictDoUpdate({
          target: [externalServiceProjectConfigs.externalServiceId, externalServiceProjectConfigs.projectEnvironmentId],
          set: {
            values: sql`${externalServiceProjectConfigs.values} || jsonb_build_object(
              'channels', ${JSON.stringify(values.channels)}::jsonb,
              'receive', coalesce(${externalServiceProjectConfigs.values}->'receive', '{}'::jsonb) || ${JSON.stringify(values.receive)}::jsonb,
              '_labels', coalesce(${externalServiceProjectConfigs.values}->'_labels', '{}'::jsonb) || ${JSON.stringify(values._labels)}::jsonb
            )`,
            updatedAt: new Date(),
          },
          setWhere: sql`NOT (${externalServiceProjectConfigs.values} ? 'channels')`,
        });
    }
    this.logger.log(
      `Moved ${rows.length - dropped} WhatsApp environment wiring(s) into Project configurations; dropped ${dropped} naming no remaining number or chat`
    );
  }
}

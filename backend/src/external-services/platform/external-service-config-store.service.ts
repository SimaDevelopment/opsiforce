import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceConfig, externalServiceResource } from '../../../db/schema';
import type { ExternalServiceDefinition, JsonValue } from './external-service-definition';
import {
  asEncryptedResourceValue,
  decryptResourceValue,
  encryptResourceValue,
  parseEncryptionKey,
} from '../../common/secret-crypto';

export interface ExternalServiceResourceRecord {
  resourceKey: string;
  value: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExternalServiceConfigRecord {
  projectEnvironmentId: string;
  value: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ExternalServiceConfigStore {
  constructor(private readonly configService: ConfigService) {}

  async getResource(service: string, resourceKey: string): Promise<JsonValue | null> {
    const key = this.encryptionKey();
    const [row] = await db
      .select({ value: externalServiceResource.value })
      .from(externalServiceResource)
      .where(and(eq(externalServiceResource.service, service), eq(externalServiceResource.resourceKey, resourceKey)));

    return row ? decryptResourceValue(key, asEncryptedResourceValue(row.value)) : null;
  }

  async listResources(service: string): Promise<ExternalServiceResourceRecord[]> {
    const key = this.encryptionKey();
    const rows = await db.select().from(externalServiceResource).where(eq(externalServiceResource.service, service));

    return rows.map((row) => ({
      resourceKey: row.resourceKey,
      value: decryptResourceValue(key, asEncryptedResourceValue(row.value)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async upsertResource(service: string, resourceKey: string, value: JsonValue): Promise<void> {
    const encrypted = encryptResourceValue(this.encryptionKey(), value);

    await db
      .insert(externalServiceResource)
      .values({ service, resourceKey, value: encrypted })
      .onConflictDoUpdate({
        target: [externalServiceResource.service, externalServiceResource.resourceKey],
        set: { value: encrypted, updatedAt: new Date() },
      });
  }

  async deleteResource(definition: ExternalServiceDefinition, resourceKey: string): Promise<boolean> {
    const referencesResource = definition.configReferencesResource?.bind(definition);
    if (referencesResource) {
      const configs = await this.listConfigs(definition.serviceName);
      if (configs.some((config) => referencesResource(config.value, resourceKey))) {
        throw new ConflictException(
          `${definition.serviceName} resource ${resourceKey} is referenced by an environment configuration`
        );
      }
    }

    const deleted = await db
      .delete(externalServiceResource)
      .where(
        and(
          eq(externalServiceResource.service, definition.serviceName),
          eq(externalServiceResource.resourceKey, resourceKey)
        )
      )
      .returning({ resourceKey: externalServiceResource.resourceKey });

    return deleted.length > 0;
  }

  async getConfig(service: string, projectEnvironmentId: string): Promise<JsonValue | null> {
    const [row] = await db
      .select({ value: externalServiceConfig.value })
      .from(externalServiceConfig)
      .where(
        and(
          eq(externalServiceConfig.service, service),
          eq(externalServiceConfig.projectEnvironmentId, projectEnvironmentId)
        )
      );

    return row?.value ?? null;
  }

  async listConfigs(service: string): Promise<ExternalServiceConfigRecord[]> {
    const rows = await db.select().from(externalServiceConfig).where(eq(externalServiceConfig.service, service));

    return rows.map((row) => ({
      projectEnvironmentId: row.projectEnvironmentId,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async createConfigIfAbsent(
    service: string,
    projectEnvironmentId: string,
    value: JsonValue
  ): Promise<JsonValue | null> {
    await db
      .insert(externalServiceConfig)
      .values({ service, projectEnvironmentId, value })
      .onConflictDoNothing({
        target: [externalServiceConfig.service, externalServiceConfig.projectEnvironmentId],
      });

    return this.getConfig(service, projectEnvironmentId);
  }

  async upsertConfig(service: string, projectEnvironmentId: string, value: JsonValue): Promise<void> {
    await db
      .insert(externalServiceConfig)
      .values({ service, projectEnvironmentId, value })
      .onConflictDoUpdate({
        target: [externalServiceConfig.service, externalServiceConfig.projectEnvironmentId],
        set: { value, updatedAt: new Date() },
      });
  }

  private encryptionKey(): Buffer {
    const hex = this.configService.get<string>('externalServicesEncryptionKey', '').trim();
    if (!hex) {
      throw new ServiceUnavailableException('External-services encryption is not configured on this platform');
    }
    return parseEncryptionKey(hex);
  }
}

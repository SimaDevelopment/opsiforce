import { Injectable } from '@nestjs/common';
import type { Field } from '@opsiforce/external-service-sdk';
import { valueFieldsOf, type ValueField } from '@opsiforce/external-service-sdk/platform';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import {
  externalServiceConfigs,
  externalServiceProjectConfigs,
  projectEnvironments,
  projects,
  type JsonValue,
} from '../../../db/schema';
import { laneReceivers } from '../inbound/event-receivers';
import type { RegisteredService } from '../registry/service-registry';
import { isPlainValues, type ConfigurationValues } from './configuration-values';
import { isGeneratedField } from './generated-values';

export interface WrittenDefault {
  key: string;
  label: string;
  value: JsonValue;
}

function defaultOf(field: ValueField): JsonValue | undefined {
  if (field.type === 'secret' || isGeneratedField(field)) return undefined;
  return 'default' in field ? (field.default as JsonValue | undefined) : undefined;
}

function wasOf(field: ValueField): string | undefined {
  return 'was' in field && typeof field.was === 'string' ? field.was : undefined;
}

export function defaultsMissingFrom(form: readonly Field[], stored: ConfigurationValues): WrittenDefault[] {
  return valueFieldsOf(form).flatMap((field) => {
    const value = defaultOf(field);
    const was = wasOf(field);
    if (value === undefined || stored[field.key] !== undefined || (was !== undefined && stored[was] !== undefined)) {
      return [];
    }
    return [{ key: field.key, label: field.label ?? field.key, value }];
  });
}

function asValues(written: WrittenDefault[]): Record<string, JsonValue> {
  return Object.fromEntries(written.map((entry) => [entry.key, entry.value]));
}

@Injectable()
export class PublishedDefaults {
  async writeInto(service: RegisteredService): Promise<void> {
    await this.writeIntoServiceConfigurations(service);
    await this.writeIntoProjectConfigurations(service);
  }

  private async writeIntoServiceConfigurations(service: RegisteredService): Promise<void> {
    const owners: SQL[] = service.home
      ? [eq(externalServiceConfigs.tenantId, service.tenantId ?? ''), isNull(externalServiceConfigs.environment)]
      : [];
    const rows = await db
      .select({ id: externalServiceConfigs.id, values: externalServiceConfigs.values })
      .from(externalServiceConfigs)
      .where(and(eq(externalServiceConfigs.externalServiceId, service.id), ...owners));
    for (const row of rows) {
      const missing = defaultsMissingFrom(
        service.manifest.serviceForm ?? [],
        isPlainValues(row.values) ? row.values : {}
      );
      if (missing.length === 0) continue;
      await db
        .update(externalServiceConfigs)
        .set({ values: sql`${JSON.stringify(asValues(missing))}::jsonb || ${externalServiceConfigs.values}` })
        .where(eq(externalServiceConfigs.id, row.id));
    }
  }

  private async writeIntoProjectConfigurations(service: RegisteredService): Promise<void> {
    const rows = await db
      .select({ id: externalServiceProjectConfigs.id, values: externalServiceProjectConfigs.values })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(and(eq(externalServiceProjectConfigs.externalServiceId, service.id), ...laneReceivers(service)));
    for (const row of rows) {
      const missing = defaultsMissingFrom(
        service.manifest.projectForm ?? [],
        isPlainValues(row.values) ? row.values : {}
      );
      if (missing.length === 0) continue;
      await db
        .update(externalServiceProjectConfigs)
        .set({ values: sql`${JSON.stringify(asValues(missing))}::jsonb || ${externalServiceProjectConfigs.values}` })
        .where(eq(externalServiceProjectConfigs.id, row.id));
    }
  }
}

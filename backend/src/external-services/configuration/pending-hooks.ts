import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import {
  externalServiceConfigs,
  externalServiceProjectConfigs,
  type ExternalServicePendingHook,
  type JsonValue,
} from '../../../db/schema';
import { SecretSealer, SecretUnreadableError } from '../../sealing/secret-sealer';
import type { HookFailure, HookOutcome } from '../gate/hook-calls';
import {
  isListItem,
  isPlainValues,
  itemPrefix,
  StoredSecret,
  type ConfigurationValues,
  type SealingPlaceOf,
} from './configuration-values';

export type PendingHookHolder = { serviceConfigId: string } | { projectConfigId: string };

export interface PendingHook {
  previous: ConfigurationValues | null;
  failure: HookFailure;
}

type LatestFailure = Omit<ExternalServicePendingHook, 'previous'>;

function keepingFirstPrevious(
  column: AnyPgColumn,
  previous: ExternalServicePendingHook['previous'],
  latest: LatestFailure
): SQL {
  const started: ExternalServicePendingHook = { previous, ...latest };
  return sql`case when ${column} is null then ${JSON.stringify(started)}::jsonb else ${column} || ${JSON.stringify(latest)}::jsonb end`;
}

@Injectable()
export class PendingHooks {
  constructor(private readonly sealer: SecretSealer) {}

  async of(holder: PendingHookHolder): Promise<PendingHook | null> {
    const pendingHook = await this.read(holder);
    if (!pendingHook) return null;
    return {
      previous: pendingHook.previous,
      failure: { callId: pendingHook.callId, code: pendingHook.code, detail: pendingHook.detail },
    };
  }

  async settle(
    holder: PendingHookHolder,
    outcome: HookOutcome,
    previous: ConfigurationValues | null,
    placeOf: SealingPlaceOf
  ): Promise<HookFailure | null> {
    if (outcome.kind !== 'failed') {
      await this.clear(holder);
      return null;
    }
    const failure = { callId: outcome.callId, code: outcome.code, detail: outcome.detail };
    const stored = previous === null ? null : (this.persisted(previous, placeOf) as { [key: string]: JsonValue });
    await this.record(holder, stored, {
      ...failure,
      failedAt: new Date().toISOString(),
    });
    return failure;
  }

  private persisted(values: ConfigurationValues, placeOf: SealingPlaceOf, prefix = ''): JsonValue {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const path = `${prefix}${key}`;
        if (value instanceof StoredSecret) return [key, this.sealedAt(value, path, placeOf)];
        if (Array.isArray(value)) {
          return [
            key,
            value.map((item) =>
              isListItem(item) ? this.persisted(item, placeOf, itemPrefix(path, item.id)) : (item as JsonValue)
            ),
          ];
        }
        return [key, isPlainValues(value) ? this.persisted(value, placeOf, `${path}.`) : (value as JsonValue)];
      })
    );
  }

  private sealedAt(secret: StoredSecret, path: string, placeOf: SealingPlaceOf): JsonValue {
    if (secret.path === path) return secret.sealed as unknown as JsonValue;
    try {
      const opened = this.sealer.open(secret.sealed as unknown as JsonValue, placeOf(secret.path));
      return this.sealer.seal(opened, placeOf(path)) as unknown as JsonValue;
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return secret.sealed as unknown as JsonValue;
    }
  }

  private async read(holder: PendingHookHolder): Promise<ExternalServicePendingHook | null> {
    if ('serviceConfigId' in holder) {
      const [row] = await db
        .select({ pendingHook: externalServiceConfigs.pendingHook })
        .from(externalServiceConfigs)
        .where(eq(externalServiceConfigs.id, holder.serviceConfigId));
      return row?.pendingHook ?? null;
    }
    const [row] = await db
      .select({ pendingHook: externalServiceProjectConfigs.pendingHook })
      .from(externalServiceProjectConfigs)
      .where(eq(externalServiceProjectConfigs.id, holder.projectConfigId));
    return row?.pendingHook ?? null;
  }

  async clear(holder: PendingHookHolder): Promise<void> {
    if ('serviceConfigId' in holder) {
      await db
        .update(externalServiceConfigs)
        .set({ pendingHook: null })
        .where(
          and(eq(externalServiceConfigs.id, holder.serviceConfigId), isNotNull(externalServiceConfigs.pendingHook))
        );
      return;
    }
    await db
      .update(externalServiceProjectConfigs)
      .set({ pendingHook: null })
      .where(
        and(
          eq(externalServiceProjectConfigs.id, holder.projectConfigId),
          isNotNull(externalServiceProjectConfigs.pendingHook)
        )
      );
  }

  private async record(
    holder: PendingHookHolder,
    previous: ExternalServicePendingHook['previous'],
    latest: LatestFailure
  ): Promise<void> {
    if ('serviceConfigId' in holder) {
      await db
        .update(externalServiceConfigs)
        .set({ pendingHook: keepingFirstPrevious(externalServiceConfigs.pendingHook, previous, latest) })
        .where(eq(externalServiceConfigs.id, holder.serviceConfigId));
      return;
    }
    await db
      .update(externalServiceProjectConfigs)
      .set({ pendingHook: keepingFirstPrevious(externalServiceProjectConfigs.pendingHook, previous, latest) })
      .where(eq(externalServiceProjectConfigs.id, holder.projectConfigId));
  }
}

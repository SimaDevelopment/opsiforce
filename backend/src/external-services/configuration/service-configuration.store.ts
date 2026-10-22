import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceConfigs, externalServices } from '../../../db/schema';
import type { JsonObject } from '../../common/json';
import { SecretSealer } from '../../sealing/secret-sealer';
import type { RegisteredService } from '../registry/service-registry';
import {
  callersOwner,
  isListItem,
  resealed,
  servicePlaceOf,
  type ConfigurationOwner,
  StoredSecret,
  type ConfigurationValues,
} from './configuration-values';
import { repeatableItemIds, savedFormValues } from './form-save';
import { GeneratedValueSource, revealedSecrets, type RevealedSecret, type SaveOptions } from './generated-values';
import { ProjectConfigurationStore, type CascadedProjectConfiguration } from './project-configuration.store';
import { removedListItems } from './removed-items';
import { readTolerantly, type TolerantRead } from './tolerant-read';
import type { Transaction } from './transaction';
import { withOwnUniqueValues } from './own-unique-values';
import { savedKeepingValuesUnique } from './unique-values';

export type AfterFirstWrite = (tx: Transaction, written: TolerantRead) => Promise<void>;

function ownerIs(owner: ConfigurationOwner): SQL[] {
  return [
    owner.tenantId === null
      ? isNull(externalServiceConfigs.tenantId)
      : eq(externalServiceConfigs.tenantId, owner.tenantId),
    owner.environment === null
      ? isNull(externalServiceConfigs.environment)
      : eq(externalServiceConfigs.environment, owner.environment),
  ];
}

export interface ServiceConfigurationSave {
  previous: TolerantRead | null;
  previousStored: ConfigurationValues | null;
  current: TolerantRead;
  revealed: RevealedSecret[];
  cascaded: CascadedProjectConfiguration[];
}

@Injectable()
export class ServiceConfigurationStore {
  constructor(
    private readonly sealer: SecretSealer,
    private readonly generatedValues: GeneratedValueSource,
    private readonly projectConfigurationStore: ProjectConfigurationStore
  ) {}

  async read(service: RegisteredService, owner: ConfigurationOwner): Promise<TolerantRead> {
    const [row] = await db
      .select({ values: externalServiceConfigs.values })
      .from(externalServiceConfigs)
      .where(and(eq(externalServiceConfigs.externalServiceId, service.id), ...ownerIs(owner)));
    return readTolerantly(service.manifest.serviceForm ?? [], row?.values ?? {});
  }

  async openedValues(
    service: RegisteredService,
    owner: ConfigurationOwner,
    keys: readonly string[]
  ): Promise<ConfigurationValues> {
    const { values } = await this.read(service, owner);
    const opened = (value: unknown): unknown => {
      if (value instanceof StoredSecret) {
        return this.sealer.open(value.sealed as JsonObject, servicePlaceOf(service, owner)(value.path));
      }
      if (Array.isArray(value)) {
        return value.map((item) =>
          isListItem(item) ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, opened(entry)])) : item
        );
      }
      return value;
    };
    return Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, opened(values[key])]));
  }

  async storedOwners(service: RegisteredService): Promise<ConfigurationOwner[]> {
    const rows = await db
      .select({ tenantId: externalServiceConfigs.tenantId, environment: externalServiceConfigs.environment })
      .from(externalServiceConfigs)
      .where(eq(externalServiceConfigs.externalServiceId, service.id));
    return rows.map((row) => ({
      tenantId: row.tenantId,
      environment: row.environment === 'development' ? 'development' : null,
    }));
  }

  async rowIdOf(service: RegisteredService, owner: ConfigurationOwner): Promise<string | null> {
    const [row] = await db
      .select({ id: externalServiceConfigs.id })
      .from(externalServiceConfigs)
      .where(and(eq(externalServiceConfigs.externalServiceId, service.id), ...ownerIs(owner)));
    return row?.id ?? null;
  }

  async readAll(services: readonly RegisteredService[], owner: ConfigurationOwner): Promise<Map<string, TolerantRead>> {
    const rows =
      services.length === 0
        ? []
        : await db
            .select({ serviceId: externalServiceConfigs.externalServiceId, values: externalServiceConfigs.values })
            .from(externalServiceConfigs)
            .where(
              and(
                inArray(
                  externalServiceConfigs.externalServiceId,
                  services.map((service) => service.id)
                ),
                ...ownerIs(owner)
              )
            );
    const storedById = new Map(rows.map((row) => [row.serviceId, row.values]));
    return new Map(
      services.map((service) => [
        service.id,
        readTolerantly(service.manifest.serviceForm ?? [], storedById.get(service.id) ?? {}),
      ])
    );
  }

  async readAllAsCallers(services: readonly RegisteredService[]): Promise<Map<string, TolerantRead>> {
    const byOwner = new Map<string, { owner: ConfigurationOwner; services: RegisteredService[] }>();
    for (const service of services) {
      const owner = callersOwner(service);
      const key = `${owner.tenantId ?? ''}|${owner.environment ?? ''}`;
      const group = byOwner.get(key) ?? { owner, services: [] };
      group.services.push(service);
      byOwner.set(key, group);
    }
    const reads = new Map<string, TolerantRead>();
    for (const group of byOwner.values()) {
      for (const [id, read] of await this.readAll(group.services, group.owner)) reads.set(id, read);
    }
    return reads;
  }

  async saveAndReport(
    service: RegisteredService,
    owner: ConfigurationOwner,
    submitted: unknown,
    options: SaveOptions = {}
  ): Promise<ServiceConfigurationSave> {
    return db.transaction(async (tx) =>
      this.saveIn(tx, service, owner, await this.storedForUpdate(tx, service, owner), submitted, options)
    );
  }

  async startWith(
    service: RegisteredService,
    owner: ConfigurationOwner,
    submitted: unknown,
    afterFirstWrite?: AfterFirstWrite
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: externalServices.id })
        .from(externalServices)
        .where(eq(externalServices.id, service.id))
        .for('update');
      if (await this.storedForUpdate(tx, service, owner)) return false;
      const saved = await this.saveIn(tx, service, owner, undefined, submitted, {});
      await afterFirstWrite?.(tx, saved.current);
      return true;
    });
  }

  private async saveIn(
    tx: Transaction,
    service: RegisteredService,
    owner: ConfigurationOwner,
    stored: ConfigurationValues | undefined,
    submitted: unknown,
    options: SaveOptions
  ): Promise<ServiceConfigurationSave> {
    const form = service.manifest.serviceForm ?? [];
    const placeOf = servicePlaceOf(service, owner);
    const itemIds = repeatableItemIds();
    const saved = await savedKeepingValuesUnique(tx, {
      serviceId: service.id,
      form,
      holder: 'service',
      stored: stored ?? {},
      prepare: (chosen) => {
        itemIds.restart();
        return savedFormValues({
          sealer: this.sealer,
          form,
          stored: stored ?? {},
          submitted,
          placeOf,
          keepRenamedKeys: options.keepRenamedKeys,
          generation: { source: this.generatedValues, fillEmpty: true, rotate: options.rotate, chosen },
          newItemId: itemIds.next,
        });
      },
      write: (next) => this.write(tx, service, owner, next.values as JsonObject),
    });
    const previous = stored ? readTolerantly(form, stored) : null;
    const current = readTolerantly(form, saved.values);
    const cascaded =
      previous && owner.environment === null
        ? await this.projectConfigurationStore.stripRemovedItems(
            tx,
            service,
            removedListItems(form, previous.values, current.values)
          )
        : [];
    return { previous, previousStored: stored ?? null, current, revealed: revealedSecrets(saved.generated), cascaded };
  }

  async storedEnvironments(service: RegisteredService): Promise<ConfigurationOwner['environment'][]> {
    const rows = await db
      .select({ environment: externalServiceConfigs.environment })
      .from(externalServiceConfigs)
      .where(
        and(
          eq(externalServiceConfigs.externalServiceId, service.id),
          service.tenantId === null
            ? isNull(externalServiceConfigs.tenantId)
            : eq(externalServiceConfigs.tenantId, service.tenantId)
        )
      );
    return rows.map((row) => (row.environment === 'development' ? 'development' : null));
  }

  async copy(
    service: RegisteredService,
    from: ConfigurationOwner,
    to: ConfigurationOwner
  ): Promise<ServiceConfigurationSave | null> {
    return db.transaction(async (tx) => {
      const [source] = await tx
        .select({ values: externalServiceConfigs.values })
        .from(externalServiceConfigs)
        .where(and(eq(externalServiceConfigs.externalServiceId, service.id), ...ownerIs(from)));
      if (!source) return null;
      const target = await this.storedForUpdate(tx, service, to);
      const copied = resealed(this.sealer, source.values, servicePlaceOf(service, from), servicePlaceOf(service, to));
      const form = service.manifest.serviceForm ?? [];
      const saved = await savedKeepingValuesUnique(tx, {
        serviceId: service.id,
        form,
        holder: 'service',
        stored: target ?? {},
        prepare: (chosen) =>
          withOwnUniqueValues(form, copied, target ?? {}, {
            generate: (field, path) => chosen.get(path) ?? this.generatedValues.next(field.generate),
          }),
        write: (next) => this.write(tx, service, to, next.values as JsonObject),
      });
      return {
        previous: target ? readTolerantly(form, target) : null,
        previousStored: target ?? null,
        current: readTolerantly(form, saved.values),
        revealed: [],
        cascaded: [],
      };
    });
  }

  private async write(
    tx: Transaction,
    service: RegisteredService,
    owner: ConfigurationOwner,
    values: JsonObject
  ): Promise<string> {
    const [row] = await tx
      .insert(externalServiceConfigs)
      .values({
        id: crypto.randomUUID(),
        externalServiceId: service.id,
        tenantId: owner.tenantId,
        environment: owner.environment,
        values,
      })
      .onConflictDoUpdate({
        target: [
          externalServiceConfigs.externalServiceId,
          externalServiceConfigs.tenantId,
          externalServiceConfigs.environment,
        ],
        set: { values, updatedAt: new Date() },
      })
      .returning({ id: externalServiceConfigs.id });
    if (!row) throw new Error(`Saving the ${service.slug} Service configuration wrote no row`);
    return row.id;
  }

  private async storedForUpdate(
    tx: Transaction,
    service: RegisteredService,
    owner: ConfigurationOwner
  ): Promise<ConfigurationValues | undefined> {
    const [row] = await tx
      .select({ values: externalServiceConfigs.values })
      .from(externalServiceConfigs)
      .where(and(eq(externalServiceConfigs.externalServiceId, service.id), ...ownerIs(owner)))
      .for('update');
    return row?.values;
  }
}

import { Injectable } from '@nestjs/common';
import { reservedProjectConfigurationKeys } from '@opsiforce/external-service-sdk/platform';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs } from '../../../db/schema';
import type { JsonObject } from '../../common/json';
import { SecretSealer } from '../../sealing/secret-sealer';
import type { RegisteredService } from '../registry/service-registry';
import { isPlainValues, resealed, type ConfigurationValues, type SealingPlaceOf } from './configuration-values';
import { generatedOnCreation, repeatableItemIds, savedFormValues } from './form-save';
import { withOwnUniqueValues } from './own-unique-values';
import { GeneratedValueSource, revealedSecrets, type RevealedSecret, type SaveOptions } from './generated-values';
import { InvalidConfigurationError, type ConfigurationIssue } from './invalid-configuration.error';
import { removedItemsNoticeOf, withoutRemovedItems, type RemovedItems, type RemovedItemsNotice } from './removed-items';
import { readTolerantly } from './tolerant-read';
import type { Transaction } from './transaction';
import { savedKeepingValuesUnique } from './unique-values';

export type ValueLabels = Record<string, Record<string, string>>;

export interface ProjectConfigurationChange {
  previous: ProjectConfiguration | null;
  current: ProjectConfiguration | null;
}

export interface CascadedProjectConfiguration {
  projectEnvironmentId: string;
  previous: ProjectConfiguration;
  current: ProjectConfiguration;
}

export interface CarriedProjectConfiguration {
  target: ProjectConfigurationChange;
}

export interface ProjectConfiguration {
  saved: boolean;
  values: ConfigurationValues;
  missing: string[];
  labels: ValueLabels;
}

const maxLabelLength = 200;

const LABELS_KEY = '_labels';

export function projectPlaceOf(service: { id: string }, projectEnvironmentId: string): SealingPlaceOf {
  return (path) => `${service.id}|environment:${projectEnvironmentId}|${path}`;
}

export interface ProjectConfigurationStart {
  values?: ConfigurationValues;
}

function reservedValues(labels: ValueLabels): ConfigurationValues {
  return { [LABELS_KEY]: labels };
}

export function storedShapeOf(configuration: ProjectConfiguration): ConfigurationValues {
  return { ...configuration.values, ...reservedValues(configuration.labels) };
}

function storedLabels(stored: unknown): ValueLabels {
  if (!isPlainValues(stored)) return {};
  const labels: ValueLabels = {};
  for (const [field, byValue] of Object.entries(stored)) {
    if (!isPlainValues(byValue)) continue;
    labels[field] = Object.fromEntries(
      Object.entries(byValue).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  }
  return labels;
}

export function projectConfigurationFromStored(
  service: RegisteredService,
  stored: ConfigurationValues | undefined
): ProjectConfiguration {
  const read = readTolerantly(service.manifest.projectForm ?? [], stored ?? {});
  return {
    saved: stored !== undefined,
    values: read.values,
    missing: read.missing,
    labels: storedLabels(stored?.[LABELS_KEY]),
  };
}

function submittedLabels(submitted: unknown, issues: ConfigurationIssue[]): ValueLabels | undefined {
  if (submitted === undefined) return undefined;
  const wellFormed =
    isPlainValues(submitted) &&
    Object.values(submitted).every(
      (byValue) =>
        isPlainValues(byValue) &&
        Object.values(byValue).every((label) => typeof label === 'string' && label.length <= maxLabelLength)
    );
  if (!wellFormed) {
    issues.push({
      pointer: `/${LABELS_KEY}`,
      message: `must map fields to {value: label} with labels of at most ${maxLabelLength} characters`,
    });
    return undefined;
  }
  return submitted as ValueLabels;
}

export interface ProjectConfigurationSave extends ProjectConfigurationChange {
  previous: ProjectConfiguration | null;
  current: ProjectConfiguration;
  revealed: RevealedSecret[];
}

function withoutLabelsOf(labels: ValueLabels, ids: ReadonlySet<string>): ValueLabels {
  return Object.fromEntries(
    Object.entries(labels).map(([field, byValue]) => [
      field,
      Object.fromEntries(Object.entries(byValue).filter(([value]) => !ids.has(value))),
    ])
  );
}

@Injectable()
export class ProjectConfigurationStore {
  constructor(
    private readonly sealer: SecretSealer,
    private readonly generatedValues: GeneratedValueSource
  ) {}

  async read(service: RegisteredService, projectEnvironmentId: string): Promise<ProjectConfiguration> {
    const [row] = await db
      .select({ values: externalServiceProjectConfigs.values })
      .from(externalServiceProjectConfigs)
      .where(this.rowOf(service, projectEnvironmentId));
    return projectConfigurationFromStored(service, row?.values);
  }

  async environmentsWithStoredConfiguration(service: RegisteredService): Promise<string[]> {
    const rows = await db
      .select({ projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId })
      .from(externalServiceProjectConfigs)
      .where(eq(externalServiceProjectConfigs.externalServiceId, service.id));
    return rows.map((row) => row.projectEnvironmentId);
  }

  async rowIdOf(service: RegisteredService, projectEnvironmentId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: externalServiceProjectConfigs.id })
      .from(externalServiceProjectConfigs)
      .where(this.rowOf(service, projectEnvironmentId));
    return row?.id ?? null;
  }

  async startWith(
    service: RegisteredService,
    projectEnvironmentId: string,
    start: ProjectConfigurationStart = {}
  ): Promise<void> {
    const reserved = reservedValues({});
    const started = { ...start.values, ...reserved } as JsonObject;
    const form = service.manifest.projectForm ?? [];
    const placeOf = projectPlaceOf(service, projectEnvironmentId);
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(externalServiceProjectConfigs)
        .values({
          id: crypto.randomUUID(),
          externalServiceId: service.id,
          projectEnvironmentId,
          values: started,
        })
        .onConflictDoNothing({
          target: [externalServiceProjectConfigs.externalServiceId, externalServiceProjectConfigs.projectEnvironmentId],
        })
        .returning({ id: externalServiceProjectConfigs.id });
      if (!created) return;
      await savedKeepingValuesUnique(tx, {
        serviceId: service.id,
        form,
        holder: 'project',
        stored: {},
        prepare: (chosen) =>
          generatedOnCreation({
            sealer: this.sealer,
            form,
            placeOf,
            generation: { source: this.generatedValues, fillEmpty: true, chosen },
          }),
        write: (generated) =>
          this.write(tx, service, projectEnvironmentId, { ...generated.values, ...started } as JsonObject),
      });
    });
  }

  async save(
    service: RegisteredService,
    projectEnvironmentId: string,
    submitted: unknown
  ): Promise<ProjectConfiguration> {
    return (await this.saveAndReport(service, projectEnvironmentId, submitted)).current;
  }

  async saveAndReport(
    service: RegisteredService,
    projectEnvironmentId: string,
    submitted: unknown,
    options: SaveOptions = {}
  ): Promise<ProjectConfigurationSave> {
    if (!isPlainValues(submitted)) {
      throw new InvalidConfigurationError([{ pointer: '/', message: 'must be an object of field values' }]);
    }
    const issues: ConfigurationIssue[] = [];
    const labels = submittedLabels(submitted[LABELS_KEY], issues);
    if (issues.length > 0) throw new InvalidConfigurationError(issues);

    const form = service.manifest.projectForm ?? [];
    const placeOf = projectPlaceOf(service, projectEnvironmentId);
    return db.transaction(async (tx) => {
      const stored = await this.storedForUpdate(tx, service, projectEnvironmentId);
      const keptLabels = options.keepLabels && stored ? undefined : labels;
      const reserved = reservedValues(keptLabels ?? storedLabels(stored?.[LABELS_KEY]));
      const itemIds = repeatableItemIds();
      const saved = await savedKeepingValuesUnique(tx, {
        serviceId: service.id,
        form,
        holder: 'project',
        stored: stored ?? {},
        prepare: (chosen) => {
          itemIds.restart();
          return savedFormValues({
            sealer: this.sealer,
            form,
            stored: stored ?? {},
            submitted,
            placeOf,
            reservedKeys: reservedProjectConfigurationKeys,
            generation: {
              source: this.generatedValues,
              fillEmpty: true,
              rotate: options.rotate,
              chosen,
            },
            newItemId: itemIds.next,
          });
        },
        write: (formValues) =>
          this.write(tx, service, projectEnvironmentId, { ...formValues.values, ...reserved } as JsonObject),
      });
      return {
        previous: stored ? projectConfigurationFromStored(service, stored) : null,
        current: projectConfigurationFromStored(service, { ...saved.values, ...reserved }),
        revealed: revealedSecrets(saved.generated),
      };
    });
  }

  async stripRemovedItems(
    tx: Transaction,
    service: RegisteredService,
    removedItems: RemovedItems
  ): Promise<CascadedProjectConfiguration[]> {
    if (removedItems.size === 0) return [];
    const removedIds = new Set<string>();
    for (const items of removedItems.values()) for (const id of items.keys()) removedIds.add(id);
    const rows = await tx
      .select({
        projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId,
        values: externalServiceProjectConfigs.values,
        notice: externalServiceProjectConfigs.notice,
      })
      .from(externalServiceProjectConfigs)
      .where(eq(externalServiceProjectConfigs.externalServiceId, service.id))
      .for('update');
    const cascaded: CascadedProjectConfiguration[] = [];
    for (const row of rows) {
      const stripped = withoutRemovedItems(service.manifest.projectForm ?? [], row.values, removedItems);
      if (stripped.removed.length === 0) continue;
      const values = {
        ...stripped.values,
        [LABELS_KEY]: withoutLabelsOf(storedLabels(row.values[LABELS_KEY]), removedIds),
      } as JsonObject;
      const notice: RemovedItemsNotice = {
        removed: [...(removedItemsNoticeOf(row.notice)?.removed ?? []), ...stripped.removed],
      };
      await tx
        .update(externalServiceProjectConfigs)
        .set({ values, notice: notice as unknown as JsonObject, updatedAt: new Date() })
        .where(this.rowOf(service, row.projectEnvironmentId));
      cascaded.push({
        projectEnvironmentId: row.projectEnvironmentId,
        previous: projectConfigurationFromStored(service, row.values),
        current: projectConfigurationFromStored(service, values),
      });
    }
    return cascaded;
  }

  async takeNotice(service: RegisteredService, projectEnvironmentId: string): Promise<RemovedItemsNotice | null> {
    const [row] = await db
      .select({ notice: externalServiceProjectConfigs.notice })
      .from(externalServiceProjectConfigs)
      .where(this.rowOf(service, projectEnvironmentId));
    const notice = removedItemsNoticeOf(row?.notice);
    if (notice) {
      await db
        .update(externalServiceProjectConfigs)
        .set({ notice: null })
        .where(this.rowOf(service, projectEnvironmentId));
    }
    return notice;
  }

  async forget(service: Pick<RegisteredService, 'id'>, projectEnvironmentId: string): Promise<void> {
    await db.delete(externalServiceProjectConfigs).where(this.rowOf(service, projectEnvironmentId));
  }

  async configuredServiceIds(projectEnvironmentId: string): Promise<string[]> {
    const rows = await db
      .select({ serviceId: externalServiceProjectConfigs.externalServiceId })
      .from(externalServiceProjectConfigs)
      .where(eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId));
    return rows.map((row) => row.serviceId);
  }

  async carry(
    service: RegisteredService,
    sourceEnvironmentId: string,
    targetEnvironmentId: string
  ): Promise<CarriedProjectConfiguration | null> {
    return db.transaction(async (tx) => {
      const source = await this.storedForUpdate(tx, service, sourceEnvironmentId);
      if (!source) return null;
      const target = await this.storedForUpdate(tx, service, targetEnvironmentId);
      const { [LABELS_KEY]: labels, ...formValues } = source;
      const form = service.manifest.projectForm ?? [];
      const targetPlaceOf = projectPlaceOf(service, targetEnvironmentId);
      const copied = resealed(this.sealer, formValues, projectPlaceOf(service, sourceEnvironmentId), targetPlaceOf);
      const reserved = reservedValues(storedLabels(labels));
      const saved = await savedKeepingValuesUnique(tx, {
        serviceId: service.id,
        form,
        holder: 'project',
        stored: target ?? {},
        prepare: (chosen) =>
          withOwnUniqueValues(form, copied, target ?? {}, {
            generate: (field, path) => chosen.get(path) ?? this.generatedValues.next(field.generate),
          }),
        write: (next) => this.write(tx, service, targetEnvironmentId, { ...next.values, ...reserved } as JsonObject),
      });
      const carried = { ...saved.values, ...reserved } as JsonObject;
      return {
        target: {
          previous: target ? projectConfigurationFromStored(service, target) : null,
          current: projectConfigurationFromStored(service, carried),
        },
      };
    });
  }

  private async write(
    tx: Transaction,
    service: RegisteredService,
    projectEnvironmentId: string,
    values: JsonObject
  ): Promise<string> {
    const [row] = await tx
      .insert(externalServiceProjectConfigs)
      .values({ id: crypto.randomUUID(), externalServiceId: service.id, projectEnvironmentId, values })
      .onConflictDoUpdate({
        target: [externalServiceProjectConfigs.externalServiceId, externalServiceProjectConfigs.projectEnvironmentId],
        set: { values, updatedAt: new Date() },
      })
      .returning({ id: externalServiceProjectConfigs.id });
    if (!row) throw new Error(`Saving the ${service.slug} Project configuration wrote no row`);
    return row.id;
  }

  private rowOf(service: Pick<RegisteredService, 'id'>, projectEnvironmentId: string) {
    return and(
      eq(externalServiceProjectConfigs.externalServiceId, service.id),
      eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId)
    );
  }

  private async storedForUpdate(
    tx: Transaction,
    service: RegisteredService,
    projectEnvironmentId: string
  ): Promise<ConfigurationValues | undefined> {
    const [row] = await tx
      .select({ values: externalServiceProjectConfigs.values })
      .from(externalServiceProjectConfigs)
      .where(this.rowOf(service, projectEnvironmentId))
      .for('update');
    return row?.values;
  }
}

import { Injectable } from '@nestjs/common';
import { defaultOperationSwitches, reservedProjectConfigurationKeys } from '@opsiforce/external-service-sdk/platform';
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

export type Switches = Record<string, boolean>;

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
  source: ProjectConfigurationChange;
  receiveTurnedOff: string[];
}

export interface ProjectConfiguration {
  saved: boolean;
  values: ConfigurationValues;
  missing: string[];
  operations: Switches;
  receive: Switches;
  labels: ValueLabels;
  newOperations: string[];
  newEventTypes: string[];
}

const maxLabelLength = 200;

const LABELS_KEY = '_labels';

export function projectPlaceOf(service: { id: string }, projectEnvironmentId: string): SealingPlaceOf {
  return (path) => `${service.id}|environment:${projectEnvironmentId}|${path}`;
}

export function storedShapeOf(configuration: ProjectConfiguration): ConfigurationValues {
  return {
    ...configuration.values,
    operations: configuration.operations,
    receive: configuration.receive,
    [LABELS_KEY]: configuration.labels,
  };
}

function storedSwitches(stored: unknown): Switches {
  if (!isPlainValues(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
  );
}

function deliveredSwitches(names: readonly string[], stored: Switches): Switches {
  return Object.fromEntries(names.map((name) => [name, stored[name] === true]));
}

function namesMissingFrom(names: readonly string[], stored: unknown): string[] {
  const known = isPlainValues(stored) ? stored : {};
  return names.filter((name) => !(name in known));
}

function everyNameOff(names: readonly string[]): Switches {
  return Object.fromEntries(names.map((name) => [name, false]));
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

function operationNamesOf(service: RegisteredService): string[] {
  return Object.keys(service.manifest.operations ?? {});
}

function eventTypesOf(service: RegisteredService): string[] {
  return Object.keys(service.manifest.events ?? {});
}

export function projectConfigurationFromStored(
  service: RegisteredService,
  stored: ConfigurationValues | undefined
): ProjectConfiguration {
  const read = readTolerantly(service.manifest.projectForm ?? [], stored ?? {});
  const operations = stored ? storedSwitches(stored.operations) : defaultOperationSwitches(service.manifest);
  return {
    saved: stored !== undefined,
    values: read.values,
    missing: read.missing,
    operations: deliveredSwitches(operationNamesOf(service), operations),
    receive: deliveredSwitches(eventTypesOf(service), stored ? storedSwitches(stored.receive) : {}),
    labels: storedLabels(stored?.[LABELS_KEY]),
    newOperations: stored ? namesMissingFrom(operationNamesOf(service), stored.operations) : [],
    newEventTypes: stored ? namesMissingFrom(eventTypesOf(service), stored.receive) : [],
  };
}

function switchedOn(switches: Switches): string[] {
  return Object.entries(switches)
    .filter(([, on]) => on)
    .map(([name]) => name);
}

function inDeclaredOrder(declared: readonly string[], names: string[]): string[] {
  const rank = (name: string) => (declared.includes(name) ? declared.indexOf(name) : declared.length);
  return names.toSorted((a, b) => rank(a) - rank(b));
}

function handedOverReceive(source: Switches, target: Switches): Switches {
  const receive = { ...source };
  for (const name of switchedOn(target)) receive[name] = true;
  return receive;
}

export function submittedSwitches(
  submitted: unknown,
  key: string,
  known: readonly string[],
  issues: ConfigurationIssue[]
): Switches {
  if (submitted === undefined) return {};
  if (!isPlainValues(submitted)) {
    issues.push({ pointer: `/${key}`, message: 'must be an object of switches' });
    return {};
  }
  const switches: Switches = {};
  for (const [name, on] of Object.entries(submitted)) {
    if (!known.includes(name)) issues.push({ pointer: `/${key}/${name}`, message: 'is not declared by this service' });
    else if (typeof on !== 'boolean') issues.push({ pointer: `/${key}/${name}`, message: 'must be true or false' });
    else switches[name] = on;
  }
  return switches;
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

export function waitsForReceive(service: RegisteredService, receive: Switches): boolean {
  return eventTypesOf(service).length > 0 && !Object.values(receive).some(Boolean);
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
    operations: Switches,
    receive: Switches = {}
  ): Promise<void> {
    const reserved = {
      operations: deliveredSwitches(operationNamesOf(service), operations),
      receive: deliveredSwitches(eventTypesOf(service), receive),
      [LABELS_KEY]: {},
    };
    const form = service.manifest.projectForm ?? [];
    const placeOf = projectPlaceOf(service, projectEnvironmentId);
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(externalServiceProjectConfigs)
        .values({
          id: crypto.randomUUID(),
          externalServiceId: service.id,
          projectEnvironmentId,
          values: reserved as JsonObject,
        })
        .onConflictDoNothing({
          target: [externalServiceProjectConfigs.externalServiceId, externalServiceProjectConfigs.projectEnvironmentId],
        })
        .returning({ id: externalServiceProjectConfigs.id });
      if (!created || waitsForReceive(service, reserved.receive)) return;
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
          this.write(tx, service, projectEnvironmentId, { ...generated.values, ...reserved } as JsonObject),
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
    const operations = submittedSwitches(submitted.operations, 'operations', operationNamesOf(service), issues);
    const receive = submittedSwitches(submitted.receive, 'receive', eventTypesOf(service), issues);
    const labels = submittedLabels(submitted[LABELS_KEY], issues);
    if (issues.length > 0) throw new InvalidConfigurationError(issues);

    const form = service.manifest.projectForm ?? [];
    const placeOf = projectPlaceOf(service, projectEnvironmentId);
    return db.transaction(async (tx) => {
      const stored = await this.storedForUpdate(tx, service, projectEnvironmentId);
      const reserved =
        options.keepSwitches && stored
          ? {
              operations: storedSwitches(stored.operations),
              receive: storedSwitches(stored.receive),
              [LABELS_KEY]: storedLabels(stored[LABELS_KEY]),
            }
          : {
              operations: {
                ...everyNameOff(operationNamesOf(service)),
                ...(stored ? storedSwitches(stored.operations) : defaultOperationSwitches(service.manifest)),
                ...operations,
              },
              receive: { ...everyNameOff(eventTypesOf(service)), ...storedSwitches(stored?.receive), ...receive },
              [LABELS_KEY]: labels ?? storedLabels(stored?.[LABELS_KEY]),
            };
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
              fillEmpty: !waitsForReceive(service, reserved.receive),
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

  async forget(service: RegisteredService, projectEnvironmentId: string): Promise<void> {
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
      const { operations, receive, [LABELS_KEY]: labels, ...formValues } = source;
      const sourceReceive = storedSwitches(receive);
      const form = service.manifest.projectForm ?? [];
      const targetPlaceOf = projectPlaceOf(service, targetEnvironmentId);
      const copied = resealed(this.sealer, formValues, projectPlaceOf(service, sourceEnvironmentId), targetPlaceOf);
      const reserved = {
        operations: storedSwitches(operations),
        receive: handedOverReceive(sourceReceive, storedSwitches(target?.receive)),
        [LABELS_KEY]: storedLabels(labels),
      };
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

      const receiveTurnedOff = inDeclaredOrder(eventTypesOf(service), switchedOn(sourceReceive));
      const sourceAfter = {
        ...source,
        receive: { ...sourceReceive, ...everyNameOff(receiveTurnedOff) },
      } as JsonObject;
      if (receiveTurnedOff.length > 0) await this.write(tx, service, sourceEnvironmentId, sourceAfter);

      return {
        target: {
          previous: target ? projectConfigurationFromStored(service, target) : null,
          current: projectConfigurationFromStored(service, carried),
        },
        source: {
          previous: projectConfigurationFromStored(service, source),
          current: projectConfigurationFromStored(service, sourceAfter),
        },
        receiveTurnedOff,
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

  private rowOf(service: RegisteredService, projectEnvironmentId: string) {
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

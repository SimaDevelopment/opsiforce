import type { Field } from '@opsiforce/external-service-sdk';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { and, eq, ne, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { externalServiceConfigs, externalServiceProjectConfigs } from '../../../db/schema';
import type { JsonObject } from '../../common/json';
import { isListItem, itemFieldsOf, itemPrefix, type ConfigurationValues } from './configuration-values';
import type { SavedFormValues } from './form-save';
import { isUniqueField } from './generated-values';
import { InvalidConfigurationError } from './invalid-configuration.error';
import type { Transaction } from './transaction';

export type UniqueValueHolder = 'service' | 'project';

interface UniqueValue {
  field: string;
  path: string;
  pointer: string;
  value: string;
  containment: JsonObject;
}

interface Position {
  path: string;
  pointer: string;
  field: string;
  within: (level: JsonObject) => JsonObject;
}

export interface UniqueValueSave {
  serviceId: string;
  form: readonly Field[];
  holder: UniqueValueHolder;
  stored: ConfigurationValues;
  prepare: (chosen: ReadonlyMap<string, string>) => SavedFormValues;
  write: (saved: SavedFormValues) => Promise<string>;
}

const maxAttempts = 5;

const topLevel: Position = { path: '', pointer: '', field: '', within: (level) => level };

function uniqueValuesOf(form: readonly Field[], values: ConfigurationValues, at = topLevel): UniqueValue[] {
  const found: UniqueValue[] = [];
  for (const field of valueFieldsOf(form)) {
    const value = values[field.key];
    const path = `${at.path}${field.key}`;
    if (field.type === 'list' && Array.isArray(value)) {
      value.forEach((item, index) => {
        if (!isListItem(item)) return;
        found.push(
          ...uniqueValuesOf(itemFieldsOf(field), item, {
            path: itemPrefix(path, item.id),
            pointer: `${at.pointer}/${field.key}/${index}`,
            field: `${at.field}${field.key}[].`,
            within: (level) => at.within({ [field.key]: [level] }),
          })
        );
      });
      continue;
    }
    if (!isUniqueField(field) || typeof value !== 'string') continue;
    found.push({
      field: `${at.field}${field.key}`,
      path,
      pointer: `${at.pointer}/${field.key}`,
      value,
      containment: at.within({ [field.key]: value }),
    });
  }
  return found;
}

function sameValue(value: UniqueValue): string {
  return `${value.field}|${value.value}`;
}

async function lockFields(tx: Transaction, serviceId: string, wanted: readonly UniqueValue[]): Promise<void> {
  const fields = [...new Set(wanted.map((value) => value.field))].toSorted();
  for (const field of fields) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`external-service-unique:${serviceId}:${field}`}))`);
  }
}

function holding(values: SQLWrapper, value: UniqueValue): SQL {
  return sql`${values} @> ${JSON.stringify(value.containment)}::jsonb`;
}

async function heldElsewhere(
  tx: Transaction,
  save: UniqueValueSave,
  configId: string,
  value: UniqueValue
): Promise<boolean> {
  const [project] = await tx
    .select({ id: externalServiceProjectConfigs.id })
    .from(externalServiceProjectConfigs)
    .where(
      and(
        eq(externalServiceProjectConfigs.externalServiceId, save.serviceId),
        holding(externalServiceProjectConfigs.values, value),
        save.holder === 'project' ? ne(externalServiceProjectConfigs.id, configId) : undefined
      )
    )
    .limit(1);
  if (project) return true;
  const [service] = await tx
    .select({ id: externalServiceConfigs.id })
    .from(externalServiceConfigs)
    .where(
      and(
        eq(externalServiceConfigs.externalServiceId, save.serviceId),
        holding(externalServiceConfigs.values, value),
        save.holder === 'service' ? ne(externalServiceConfigs.id, configId) : undefined
      )
    )
    .limit(1);
  return service !== undefined;
}

async function collisions(
  tx: Transaction,
  save: UniqueValueSave,
  configId: string,
  wanted: readonly UniqueValue[]
): Promise<UniqueValue[]> {
  await lockFields(tx, save.serviceId, wanted);
  const collided: UniqueValue[] = [];
  const seen = new Set<string>();
  for (const value of wanted) {
    const key = sameValue(value);
    if (seen.has(key) || (await heldElsewhere(tx, save, configId, value))) collided.push(value);
    seen.add(key);
  }
  return collided;
}

function storedAt(value: UniqueValue): string {
  return `${value.path}|${value.value}`;
}

export async function savedKeepingValuesUnique(tx: Transaction, save: UniqueValueSave): Promise<SavedFormValues> {
  const chosen = new Map<string, string>();
  const alreadyHeld = new Set(uniqueValuesOf(save.form, save.stored).map(storedAt));
  for (let attempt = 1; ; attempt += 1) {
    const saved = save.prepare(chosen);
    const configId = await save.write(saved);
    const wanted = uniqueValuesOf(save.form, saved.values);
    if (wanted.length === 0) return saved;
    const collided = (await collisions(tx, save, configId, wanted)).filter(
      (value) => !alreadyHeld.has(storedAt(value))
    );
    if (collided.length === 0) return saved;

    const generatedPaths = new Set(saved.generated.map((value) => value.path));
    const typed = collided.filter((value) => !generatedPaths.has(value.path));
    if (typed.length > 0) {
      throw new InvalidConfigurationError(typed.map((value) => ({ pointer: value.pointer, message: 'is taken' })));
    }
    if (attempt === maxAttempts) {
      throw new Error(`Could not generate unique values for ${collided.map((value) => value.path).join(', ')}`);
    }
    const collidedPaths = new Set(collided.map((value) => value.path));
    chosen.clear();
    for (const value of saved.generated) {
      if (!collidedPaths.has(value.path)) chosen.set(value.path, value.value);
    }
  }
}

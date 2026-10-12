import { randomBytes } from 'node:crypto';
import type { Field } from '@opsiforce/external-service-sdk';
import { formValuesSchema, valueFieldsOf, visibleFieldKeys } from '@opsiforce/external-service-sdk/platform';
import type { JsonValue } from '../../common/json';
import type { SealedSecret, SecretSealer } from '../../sealing/secret-sealer';
import {
  isListItem,
  isPlainValues,
  itemFieldsOf,
  itemPrefix,
  StoredSecret,
  withStandIns,
  type ConfigurationValues,
  type SealingPlaceOf,
} from './configuration-values';
import { isGeneratedField, type GeneratedValue, type GeneratedValueSource } from './generated-values';
import { InvalidConfigurationError, type ConfigurationIssue } from './invalid-configuration.error';
import { readTolerantly } from './tolerant-read';

export interface Generation {
  source: GeneratedValueSource;
  fillEmpty: boolean;
  rotate?: string;
  chosen?: ReadonlyMap<string, string>;
}

export interface FormSave {
  sealer: SecretSealer;
  form: readonly Field[];
  stored: ConfigurationValues;
  submitted: unknown;
  placeOf: SealingPlaceOf;
  reservedKeys?: readonly string[];
  keepRenamedKeys?: boolean;
  generation?: Generation;
  newItemId?: () => string;
}

export interface SavedFormValues {
  values: ConfigurationValues;
  generated: GeneratedValue[];
}

export function newListItemId(): string {
  return `li_${randomBytes(8).toString('hex')}`;
}

export interface RepeatableItemIds {
  next: () => string;
  restart: () => void;
}

export function repeatableItemIds(): RepeatableItemIds {
  const issued: string[] = [];
  let position = 0;
  return {
    next: () => {
      if (position === issued.length) issued.push(newListItemId());
      return issued[position++] as string;
    },
    restart: () => {
      position = 0;
    },
  };
}

type ItemIdOf = (submitted: ConfigurationValues, existing: ConfigurationValues | undefined) => string;

function storedOrNewItemId(newItemId: () => string): ItemIdOf {
  return (_submitted, existing) => (typeof existing?.id === 'string' ? existing.id : newItemId());
}

const submittedItemId: ItemIdOf = (submitted, existing) =>
  typeof submitted.id === 'string' ? submitted.id : storedOrNewItemId(newListItemId)(submitted, existing);

function isTypedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function mergedSubmission(
  form: readonly Field[],
  submitted: ConfigurationValues,
  current: ConfigurationValues,
  itemIdOf: ItemIdOf
) {
  const merged: ConfigurationValues = {};
  for (const field of valueFieldsOf(form)) {
    const value = submitted[field.key];
    if (field.type === 'secret') {
      if (isTypedText(value)) merged[field.key] = value;
      else if (current[field.key] instanceof StoredSecret) merged[field.key] = current[field.key];
    } else if (isGeneratedField(field)) {
      if (isTypedText(value)) merged[field.key] = value;
      else if (current[field.key] !== undefined) merged[field.key] = current[field.key];
    } else if (field.type === 'list' && Array.isArray(value)) {
      const currentItems = Array.isArray(current[field.key]) ? (current[field.key] as unknown[]) : [];
      merged[field.key] = value.map((item) => {
        if (!isPlainValues(item)) return item;
        const existing = currentItems.filter(isListItem).find((candidate) => candidate.id === item.id);
        return {
          ...mergedSubmission(itemFieldsOf(field), item, existing ?? {}, itemIdOf),
          id: itemIdOf(item, existing),
        };
      });
    } else if (value !== undefined) {
      merged[field.key] = value;
    }
  }
  return merged;
}

export function unsavedWithStoredSecrets(
  form: readonly Field[],
  submitted: ConfigurationValues,
  current: ConfigurationValues
): ConfigurationValues {
  return mergedSubmission(form, submitted, current, submittedItemId);
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): ConfigurationIssue[] {
  return error.issues.map((issue) => ({
    pointer: `/${issue.path.map(String).join('/')}`,
    message: issue.message,
  }));
}

function retainedRemovedKeys(
  form: readonly Field[],
  stored: ConfigurationValues,
  reservedKeys: readonly string[],
  keepRenamedKeys: boolean
): ConfigurationValues {
  const known = new Set<string>(reservedKeys);
  for (const field of valueFieldsOf(form)) {
    known.add(field.key);
    if (field.was !== undefined && !keepRenamedKeys) known.add(field.was);
  }
  return Object.fromEntries(Object.entries(stored).filter(([key]) => !known.has(key)));
}

function sealedSecret(save: FormSave, value: unknown, path: string): SealedSecret {
  const place = save.placeOf(path);
  if (!(value instanceof StoredSecret)) return save.sealer.seal(value as JsonValue, place);
  if (value.path === path) return value.sealed;
  return save.sealer.seal(save.sealer.open(value.sealed, save.placeOf(value.path)), place);
}

function sealedLevel(
  save: FormSave,
  form: readonly Field[],
  validated: ConfigurationValues,
  merged: ConfigurationValues,
  prefix: string
): ConfigurationValues {
  const level: ConfigurationValues = {};
  for (const field of valueFieldsOf(form)) {
    const value = validated[field.key];
    if (value === undefined) continue;
    const path = `${prefix}${field.key}`;
    if (field.type === 'secret') {
      level[field.key] = sealedSecret(save, merged[field.key], path);
    } else if (field.type === 'list' && Array.isArray(value)) {
      const mergedItems = merged[field.key] as ConfigurationValues[];
      level[field.key] = value.map((item: ConfigurationValues, index) => {
        const id = String(mergedItems[index]?.id);
        return { ...sealedLevel(save, itemFieldsOf(field), item, mergedItems[index] ?? {}, itemPrefix(path, id)), id };
      });
    } else {
      level[field.key] = value;
    }
  }
  return level;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function filledGenerated(
  form: readonly Field[],
  level: ConfigurationValues,
  generation: Generation,
  prefix: string
): GeneratedValue[] {
  const visible = visibleFieldKeys(form, withStandIns(form, level));
  const filled: GeneratedValue[] = [];
  for (const field of valueFieldsOf(form)) {
    if (!visible.has(field.key)) continue;
    const path = `${prefix}${field.key}`;
    const value = level[field.key];
    if (field.type === 'list' && Array.isArray(value)) {
      for (const item of value) {
        if (isListItem(item)) {
          filled.push(...filledGenerated(itemFieldsOf(field), item, generation, itemPrefix(path, item.id)));
        }
      }
      continue;
    }
    if (!isGeneratedField(field)) continue;
    if (generation.rotate !== path && !(generation.fillEmpty && isEmptyValue(value))) continue;
    const generated = generation.chosen?.get(path) ?? generation.source.next(field.generate);
    level[field.key] = generated;
    filled.push({ path, value: generated, secret: field.type === 'secret' });
  }
  return filled;
}

export function generatedOnCreation(
  save: Pick<FormSave, 'sealer' | 'form' | 'placeOf'> & { generation: Generation }
): SavedFormValues {
  const values: ConfigurationValues = {};
  const generated = filledGenerated(save.form, values, save.generation, '');
  for (const { path, value, secret } of generated) {
    if (secret) values[path] = save.sealer.seal(value, save.placeOf(path));
  }
  return { values, generated };
}

const placeholderSource = { next: () => '' } as unknown as GeneratedValueSource;

export function emptyGeneratedPaths(form: readonly Field[], values: ConfigurationValues): string[] {
  return filledGenerated(form, withStandIns(form, values), { source: placeholderSource, fillEmpty: true }, '').map(
    (generated) => generated.path
  );
}

export function savedFormValues(save: FormSave): SavedFormValues {
  if (!isPlainValues(save.submitted)) {
    throw new InvalidConfigurationError([{ pointer: '/', message: 'must be an object of field values' }]);
  }
  const current = readTolerantly(save.form, save.stored).values;
  const merged = mergedSubmission(
    save.form,
    save.submitted,
    current,
    storedOrNewItemId(save.newItemId ?? newListItemId)
  );
  const generated = save.generation ? filledGenerated(save.form, merged, save.generation, '') : [];
  const result = formValuesSchema(save.form).safeParse(withStandIns(save.form, merged));
  if (!result.success) throw new InvalidConfigurationError(issuesOf(result.error));
  return {
    values: {
      ...retainedRemovedKeys(save.form, save.stored, save.reservedKeys ?? [], save.keepRenamedKeys ?? false),
      ...sealedLevel(save, save.form, result.data, merged, ''),
    },
    generated,
  };
}

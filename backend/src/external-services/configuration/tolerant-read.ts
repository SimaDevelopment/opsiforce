import type { Field } from '@opsiforce/external-service-sdk';
import {
  formValuesSchema,
  valueFieldsOf,
  visibleFieldKeys,
  type ValueField,
} from '@opsiforce/external-service-sdk/platform';
import {
  isListItem,
  isPlainValues,
  itemFieldsOf,
  itemPrefix,
  sealedSecretOf,
  StoredSecret,
  withStandIns,
  type ConfigurationValues,
} from './configuration-values';

export interface TolerantRead {
  values: ConfigurationValues;
  missing: string[];
}

interface FieldAddress {
  holder: ConfigurationValues;
  key: string;
  path: string;
}

function storedKeyOf(field: ValueField, stored: ConfigurationValues): string | null {
  if (stored[field.key] !== undefined) return field.key;
  if (field.was !== undefined && stored[field.was] !== undefined) return field.was;
  return null;
}

function movedValue(field: ValueField, raw: unknown, storedPath: string): unknown {
  if (field.type === 'secret') {
    const sealed = sealedSecretOf(raw);
    return sealed ? new StoredSecret(sealed, storedPath) : undefined;
  }
  if (field.type === 'list' && Array.isArray(raw)) {
    return raw.map((item) =>
      isListItem(item)
        ? { ...movedLevel(itemFieldsOf(field), item, itemPrefix(storedPath, item.id)), id: item.id }
        : item
    );
  }
  return raw;
}

function movedLevel(form: readonly Field[], stored: ConfigurationValues, prefix = ''): ConfigurationValues {
  const values: ConfigurationValues = {};
  for (const field of valueFieldsOf(form)) {
    const storedKey = storedKeyOf(field, stored);
    if (storedKey === null) continue;
    const value = movedValue(field, stored[storedKey], `${prefix}${storedKey}`);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

function addressOf(form: readonly Field[], values: ConfigurationValues, issuePath: PropertyKey[]): FieldAddress | null {
  const [key, index, itemKey] = issuePath;
  if (typeof key !== 'string') return null;
  const field = valueFieldsOf(form).find((candidate) => candidate.key === key);
  if (!field) return null;
  const items = values[key];
  if (field.type === 'list' && typeof index === 'number' && typeof itemKey === 'string' && Array.isArray(items)) {
    const item: unknown = items[index];
    if (isPlainValues(item)) {
      return { holder: item, key: itemKey, path: `${key}.${isListItem(item) ? item.id : index}.${itemKey}` };
    }
  }
  return { holder: values, key, path: key };
}

function delivered(form: readonly Field[], values: ConfigurationValues): ConfigurationValues {
  const visible = visibleFieldKeys(form, withStandIns(form, values));
  const result: ConfigurationValues = {};
  for (const field of valueFieldsOf(form)) {
    const value = values[field.key];
    if (!visible.has(field.key) || value === undefined || value === null) continue;
    if (field.type === 'list' && Array.isArray(value)) {
      result[field.key] = value
        .filter(isListItem)
        .map((item) => Object.assign(delivered(itemFieldsOf(field), item), { id: item.id }));
    } else {
      result[field.key] = value;
    }
  }
  return result;
}

export function readTolerantly(form: readonly Field[], stored: ConfigurationValues): TolerantRead {
  const values = movedLevel(form, stored);
  const schema = formValuesSchema(form);
  for (;;) {
    const result = schema.safeParse(withStandIns(form, values));
    if (result.success) return { values: delivered(form, values), missing: [] };

    const missing = new Set<string>();
    let droppedMisfit = false;
    for (const issue of result.error.issues) {
      const address = addressOf(form, values, issue.path);
      if (!address) continue;
      if (address.holder[address.key] === undefined) {
        missing.add(address.path);
      } else {
        delete address.holder[address.key];
        droppedMisfit = true;
      }
    }
    if (!droppedMisfit) return { values: delivered(form, values), missing: [...missing] };
  }
}

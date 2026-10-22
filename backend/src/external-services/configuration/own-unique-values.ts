import type { Field } from '@opsiforce/external-service-sdk';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { isListItem, isPlainValues, itemFieldsOf, itemPrefix, type ConfigurationValues } from './configuration-values';
import type { SavedFormValues } from './form-save';
import { isUniqueField, type GeneratedValue, type UniqueField } from './generated-values';

export interface OwnValueSource {
  generate: (field: UniqueField, path: string) => string;
}

function itemWithId(values: ConfigurationValues, key: string, id: string): ConfigurationValues {
  const items = values[key];
  const item = Array.isArray(items) ? items.find((entry) => isListItem(entry) && entry.id === id) : undefined;
  return isPlainValues(item) ? item : {};
}

function ownLevel(
  form: readonly Field[],
  copied: ConfigurationValues,
  own: ConfigurationValues,
  source: OwnValueSource,
  generated: GeneratedValue[],
  prefix: string
): ConfigurationValues {
  const level: ConfigurationValues = { ...copied };
  for (const field of valueFieldsOf(form)) {
    const value = level[field.key];
    const path = `${prefix}${field.key}`;
    if (field.type === 'list' && Array.isArray(value)) {
      level[field.key] = value.map((item) =>
        isListItem(item)
          ? {
              ...ownLevel(
                itemFieldsOf(field),
                item,
                itemWithId(own, field.key, item.id),
                source,
                generated,
                itemPrefix(path, item.id)
              ),
              id: item.id,
            }
          : item
      );
      continue;
    }
    if (!isUniqueField(field) || value === undefined) continue;
    if (own[field.key] !== undefined) {
      level[field.key] = own[field.key];
      continue;
    }
    const fresh = source.generate(field, path);
    generated.push({ path, value: fresh, secret: false });
    level[field.key] = fresh;
  }
  return level;
}

export function withOwnUniqueValues(
  form: readonly Field[],
  copied: ConfigurationValues,
  own: ConfigurationValues,
  source: OwnValueSource
): SavedFormValues {
  const generated: GeneratedValue[] = [];
  return { values: ownLevel(form, copied, own, source, generated, ''), generated };
}

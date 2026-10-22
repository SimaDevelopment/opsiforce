import type { Field } from '@opsiforce/external-service-sdk';
import { valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import { isListItem, isPlainValues, itemFieldsOf, itemPrefix, type ConfigurationValues } from './configuration-values';
import { isGeneratedField } from './generated-values';
import { InvalidConfigurationError } from './invalid-configuration.error';

function isGeneratedKey(form: readonly Field[], key: string): boolean {
  return valueFieldsOf(form).some((field) => field.key === key && isGeneratedField(field));
}

function itemPath(form: readonly Field[], values: ConfigurationValues, key: string, itemId: string): string | null {
  for (const field of valueFieldsOf(form)) {
    if (field.type !== 'list' || !isGeneratedKey(itemFieldsOf(field), key)) continue;
    const items = values[field.key];
    if (Array.isArray(items) && items.some((item) => isListItem(item) && item.id === itemId)) {
      return `${itemPrefix(field.key, itemId)}${key}`;
    }
  }
  return null;
}

export function rotationTarget(form: readonly Field[], values: ConfigurationValues, target: unknown): string {
  const { field, item } = isPlainValues(target) ? target : {};
  if (typeof field !== 'string' || (item !== undefined && typeof item !== 'string')) {
    throw new InvalidConfigurationError([
      { pointer: '/field', message: 'must name the generated field to rotate, with the list item id in item' },
    ]);
  }
  const path =
    typeof item === 'string' ? itemPath(form, values, field, item) : isGeneratedKey(form, field) ? field : null;
  if (path === null) {
    throw new InvalidConfigurationError([{ pointer: '/field', message: 'is not a generated field of this form' }]);
  }
  return path;
}

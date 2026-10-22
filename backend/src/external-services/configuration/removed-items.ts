import type { Field } from '@opsiforce/external-service-sdk';
import { serviceConfigurationSourceOf, valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import {
  isListItem,
  isPlainValues,
  itemFieldsOf,
  type ConfigurationValues,
  type ListItemValues,
} from './configuration-values';

export type RemovedItems = Map<string, Map<string, ListItemValues>>;

export interface RemovedItem {
  label: string;
  fields: string[];
}

export interface RemovedItemsNotice {
  removed: RemovedItem[];
}

export interface StrippedValues {
  values: ConfigurationValues;
  removed: RemovedItem[];
}

function itemsOf(values: ConfigurationValues, key: string): ListItemValues[] {
  const items = values[key];
  return Array.isArray(items) ? items.filter(isListItem) : [];
}

export function removedListItems(
  form: readonly Field[],
  previous: ConfigurationValues,
  current: ConfigurationValues
): RemovedItems {
  const removed: RemovedItems = new Map();
  for (const field of valueFieldsOf(form)) {
    if (field.type !== 'list') continue;
    const kept = new Set(itemsOf(current, field.key).map((item) => item.id));
    const gone = itemsOf(previous, field.key).filter((item) => !kept.has(item.id));
    if (gone.length > 0) removed.set(field.key, new Map(gone.map((item) => [item.id, item])));
  }
  return removed;
}

function labelOf(item: ListItemValues, labelKey: string): string {
  const label = item[labelKey];
  return typeof label === 'string' && label !== '' ? label : item.id;
}

function strippedLevel(
  form: readonly Field[],
  values: ConfigurationValues,
  removedItems: RemovedItems,
  found: Map<string, RemovedItem>,
  labelPrefix = ''
): ConfigurationValues {
  const level: ConfigurationValues = { ...values };
  for (const field of valueFieldsOf(form)) {
    const value = level[field.key];
    const fieldLabel = `${labelPrefix}${field.label ?? field.key}`;
    if (field.type === 'list' && Array.isArray(value)) {
      level[field.key] = value.map((item) =>
        isPlainValues(item) ? strippedLevel(itemFieldsOf(field), item, removedItems, found, `${fieldLabel} › `) : item
      );
      continue;
    }
    const source = serviceConfigurationSourceOf(field);
    const gone = source ? removedItems.get(source.serviceConfiguration) : undefined;
    if (!source || !gone) continue;
    const strip = (id: unknown): boolean => {
      const item = typeof id === 'string' ? gone.get(id) : undefined;
      if (!item) return false;
      const entry = found.get(item.id) ?? { label: labelOf(item, source.labelKey), fields: [] };
      if (!entry.fields.includes(fieldLabel)) entry.fields.push(fieldLabel);
      found.set(item.id, entry);
      return true;
    };
    if (Array.isArray(value)) level[field.key] = value.filter((id) => !strip(id));
    else if (strip(value)) delete level[field.key];
  }
  return level;
}

export function withoutRemovedItems(
  form: readonly Field[],
  values: ConfigurationValues,
  removedItems: RemovedItems
): StrippedValues {
  const found = new Map<string, RemovedItem>();
  const stripped = strippedLevel(form, values, removedItems, found);
  return { values: stripped, removed: [...found.values()] };
}

export function removedItemsNoticeOf(stored: unknown): RemovedItemsNotice | null {
  if (!isPlainValues(stored) || !Array.isArray(stored.removed)) return null;
  return { removed: stored.removed as RemovedItem[] };
}

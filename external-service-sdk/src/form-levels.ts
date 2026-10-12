import type { Field, VisibleWhen } from './fields.ts';
import { Secret } from './secret.ts';

export type KeyedField = Exclude<Field, { type: 'section' }>;
export type ValueField = Exclude<Field, { type: 'section' | 'info' | 'button' }>;

export interface PlacedField {
  field: KeyedField;
  conditions: VisibleWhen[];
}

export type FormValues = Record<string, unknown>;

export interface ServiceConfigurationSource {
  serviceConfiguration: string;
  labelKey: string;
}

export const reservedProjectConfigurationKeys = ['operations', 'receive', '_labels'] as const;

export function placedFieldsOf(fields: readonly Field[], conditions: VisibleWhen[] = []): PlacedField[] {
  return fields.flatMap((field): PlacedField[] => {
    const own = field.visibleWhen ? [...conditions, field.visibleWhen] : conditions;
    if (field.type === 'section') return placedFieldsOf(field.fields, own);
    return [{ field, conditions: own }];
  });
}

export function isValueField(field: KeyedField): field is ValueField {
  return field.type !== 'info' && field.type !== 'button';
}

export function valueFieldsOf(fields: readonly Field[]): ValueField[] {
  return placedFieldsOf(fields)
    .map(({ field }) => field)
    .filter(isValueField);
}

export function fieldNamed(fields: readonly Field[] | undefined, key: string): KeyedField | undefined {
  return placedFieldsOf(fields ?? []).find(({ field }) => field.key === key)?.field;
}

export function eachKeyedField(fields: readonly Field[] | undefined, visit: (field: KeyedField) => void): void {
  for (const { field } of placedFieldsOf(fields ?? [])) {
    visit(field);
    if (field.type === 'list') eachKeyedField(field.item, visit);
  }
}

export function serviceConfigurationSourceOf(field: Field): ServiceConfigurationSource | null {
  if (!('options' in field) || Array.isArray(field.options) || !('serviceConfiguration' in field.options)) return null;
  return { serviceConfiguration: field.options.serviceConfiguration, labelKey: field.options.labelKey };
}

export function isPlainObject(value: unknown): value is FormValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Secret);
}

export function withSecrets(fields: readonly Field[] | undefined, values: unknown): FormValues {
  if (!isPlainObject(values)) return {};
  const result: FormValues = { ...values };
  for (const field of valueFieldsOf(fields ?? [])) {
    const value = values[field.key];
    if (field.type === 'secret' && typeof value === 'string') result[field.key] = new Secret(value);
    if (field.type === 'list' && Array.isArray(value)) {
      result[field.key] = value.map((item) => (isPlainObject(item) ? withSecrets(field.item, item) : item));
    }
  }
  return result;
}

export function withoutKeys(values: unknown, keys: readonly string[]): FormValues {
  if (!isPlainObject(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
}

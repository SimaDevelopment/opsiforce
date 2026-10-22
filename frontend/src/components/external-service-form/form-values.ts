import { formValuesSchema, secretStandIn, valueFieldsOf, type Field } from '@opsiforce/external-service-sdk/forms';
import { unwrap } from 'solid-js/store';

export type FormValues = Record<string, unknown>;

export type FieldPath = readonly (string | number)[];

export type ListItem = FormValues & { id: string };

export const KEPT_SECRET = { stored: true } as const;

export function isPlainValues(value: unknown): value is FormValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isKeptSecret(value: unknown): boolean {
  return isPlainValues(value) && value.stored === true;
}

export function isListItem(value: unknown): value is ListItem {
  return isPlainValues(value) && typeof value.id === 'string';
}

export function newListItemId(): string {
  return `new_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function valueAt(values: FormValues, path: FieldPath): unknown {
  let current: unknown = values;
  for (const step of path) {
    if (Array.isArray(current) && typeof step === 'number') current = current[step];
    else if (isPlainValues(current)) current = current[String(step)];
    else return undefined;
  }
  return current;
}

export function errorKeyOf(values: FormValues, path: FieldPath): string {
  const parts: string[] = [];
  let current: unknown = values;
  for (const step of path) {
    if (Array.isArray(current) && typeof step === 'number') {
      const item: unknown = current[step];
      parts.push(isListItem(item) ? item.id : String(step));
      current = item;
    } else {
      parts.push(String(step));
      current = isPlainValues(current) ? current[String(step)] : undefined;
    }
  }
  return parts.join('.');
}

export function errorKeyOfPointer(values: FormValues, pointer: string): string {
  const path = pointer
    .split('/')
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return errorKeyOf(values, path);
}

export function fieldLabelOfPath(fields: readonly Field[], path: string): string {
  const segments = path.split('.');
  const field = valueFieldsOf(fields).find((candidate) => candidate.key === segments[0]);
  if (!field) return path;
  const label = field.label ?? field.key;
  const itemKey = segments.length >= 3 ? segments.at(-1) : undefined;
  if (field.type !== 'list' || itemKey === undefined) return label;
  const itemField = valueFieldsOf(field.item).find((candidate) => candidate.key === itemKey);
  return `${label} › ${itemField?.label ?? itemKey}`;
}

export function isSectionVisible(section: Extract<Field, { type: 'section' }>, visible: Set<string>): boolean {
  return section.fields.some((field) => visible.has(field.key));
}

function withStandIns(fields: readonly Field[], values: FormValues): FormValues {
  const copy: FormValues = { ...values };
  for (const field of valueFieldsOf(fields)) {
    const value = values[field.key];
    if (field.type === 'secret' && isKeptSecret(value)) copy[field.key] = secretStandIn;
    else if (field.type === 'list' && Array.isArray(value)) {
      copy[field.key] = value.map((item) => (isPlainValues(item) ? withStandIns(field.item, item) : item));
    }
  }
  return copy;
}

function withGeneratedOptional(fields: readonly Field[]): Field[] {
  return fields.map((field) => {
    if (field.type === 'section') return { ...field, fields: withGeneratedOptional(field.fields) };
    if (field.type === 'list') return { ...field, item: withGeneratedOptional(field.item) };
    if ((field.type === 'text' || field.type === 'secret') && field.generate) return { ...field, required: false };
    return field;
  }) as Field[];
}

export function validateFormValues(fields: readonly Field[], values: FormValues): Map<string, string> {
  const result = formValuesSchema(withGeneratedOptional(fields)).safeParse(withStandIns(fields, values));
  const errors = new Map<string, string>();
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const key = errorKeyOf(
      values,
      issue.path.map((step) => (typeof step === 'number' ? step : String(step)))
    );
    if (!errors.has(key)) errors.set(key, issue.message);
  }
  return errors;
}

export function storedOrDefaults(fields: readonly Field[], stored: FormValues): FormValues {
  return Object.keys(stored).length === 0 ? withDefaults(fields, stored) : stored;
}

export function withDefaults(fields: readonly Field[], values: FormValues): FormValues {
  const filled: FormValues = { ...values };
  for (const field of valueFieldsOf(fields)) {
    if (filled[field.key] === undefined && 'default' in field && field.default !== undefined) {
      filled[field.key] = structuredClone(unwrap(field.default));
    }
  }
  return filled;
}

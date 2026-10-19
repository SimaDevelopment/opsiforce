import { z } from 'zod';

import type { Field, VisibleWhen } from './fields.ts';
import { isPlainObject, placedFieldsOf, type FormValues, type PlacedField, type ValueField } from './form-levels.ts';

export const secretStandIn = 'stored-secret';

export const formValueLimits = {
  textLength: 10_000,
  textareaLength: 100_000,
  secretLength: 64 * 1024,
  optionValueLength: 200,
  multiselectItems: 500,
  listItems: 100,
  keyValueEntries: 100,
  keyValueKeyLength: 200,
  keyValueValueLength: 10_000,
} as const;

const emailPattern = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;
const hostnameLabelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const e164Pattern = /^\+[1-9]\d{1,14}$/;

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => hostnameLabelPattern.test(label));
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  return value.includes(':') && /^[0-9a-f:.]+$/i.test(value) && URL.canParse(`http://[${value}]/`);
}

function isIpOrCidr(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  if (rest.length > 0) return false;
  const v4 = isIpv4(address);
  if (!v4 && !isIpv6(address)) return false;
  if (prefix === undefined) return true;
  return /^(0|[1-9]\d{0,2})$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128);
}

function isUrl(value: string, allowHttp: boolean): boolean {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || (allowHttp && protocol === 'http:');
}

type TextField = Extract<ValueField, { type: 'text' | 'textarea' }>;

function textSchema(field: TextField): z.ZodType {
  const validate = field.validate ?? {};
  const maxLength = Math.min(
    validate.maxLength ?? Number.POSITIVE_INFINITY,
    field.type === 'text' ? formValueLimits.textLength : formValueLimits.textareaLength
  );
  let schema = z.string().max(maxLength);
  if (validate.minLength !== undefined) schema = schema.min(validate.minLength);
  switch (validate.format) {
    case 'email':
      return schema.refine((value) => value.length <= 254 && emailPattern.test(value), 'must be an email address');
    case 'emailOrDomain':
      return schema.refine(
        (value) => emailPattern.test(value) || (value.includes('.') && isHostname(value)),
        'must be an email address or a domain'
      );
    case 'url':
      return schema.refine(
        (value) => isUrl(value, validate.allowHttp === true),
        validate.allowHttp ? 'must be an http or https URL' : 'must be an https URL'
      );
    case 'hostname':
      return schema.refine(isHostname, 'must be a hostname');
    case 'e164':
      return schema.refine(
        (value) => e164Pattern.test(value),
        'must be a phone number in E.164 form, like +14155550123'
      );
    case 'ipOrCidr':
      return schema.refine(isIpOrCidr, 'must be an IP address or a CIDR range');
    default:
      return schema;
  }
}

function optionValueSchema(field: Extract<ValueField, { type: 'radio' | 'select' | 'multiselect' }>): z.ZodType {
  if (Array.isArray(field.options)) {
    const values = field.options.map((option) => option.value);
    return z.string().refine((value) => values.includes(value), `must be one of: ${values.join(', ')}`);
  }
  return z.string().min(1).max(formValueLimits.optionValueLength);
}

function numberSchema(field: Extract<ValueField, { type: 'number' }>): z.ZodType {
  let schema = field.integer ? z.int() : z.number();
  if (field.min !== undefined) schema = schema.min(field.min);
  if (field.max !== undefined) schema = schema.max(field.max);
  const { step } = field;
  if (step === undefined) return schema;
  const origin = field.min ?? 0;
  return schema.refine(
    (value) => {
      const steps = (value - origin) / step;
      return Math.abs(steps - Math.round(steps)) < 1e-9;
    },
    `must be a multiple of ${step}${origin === 0 ? '' : ` from ${origin}`}`
  );
}

function valueSchema(field: ValueField): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return textSchema(field);
    case 'number':
      return numberSchema(field);
    case 'toggle':
      return z.boolean();
    case 'radio':
    case 'select':
      return optionValueSchema(field);
    case 'multiselect': {
      const minItems = field.minItems ?? 0;
      return z
        .array(optionValueSchema(field))
        .max(Math.min(field.maxItems ?? formValueLimits.multiselectItems, formValueLimits.multiselectItems))
        .refine((values) => new Set(values).size === values.length, 'lists a value twice')
        .refine((values) => values.length === 0 || values.length >= minItems, `choose at least ${minItems}`);
    }
    case 'secret':
      return z.string().max(formValueLimits.secretLength);
    case 'keyValue':
      return z
        .record(
          z.string().min(1).max(formValueLimits.keyValueKeyLength),
          z.string().max(formValueLimits.keyValueValueLength)
        )
        .refine(
          (values) => Object.keys(values).length <= formValueLimits.keyValueEntries,
          `at most ${formValueLimits.keyValueEntries} entries`
        );
    case 'list':
      return z.array(levelSchema(field.item, true)).max(field.maxItems ?? formValueLimits.listItems);
  }
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function holds(condition: VisibleWhen, value: unknown): boolean {
  if ('equals' in condition) {
    return Array.isArray(value) ? value.includes(condition.equals) : value === condition.equals;
  }
  if ('in' in condition) {
    return Array.isArray(value)
      ? value.some((entry) => condition.in.includes(entry))
      : condition.in.includes(value as string | number | boolean);
  }
  return !isMissing(value) && value !== false && value !== 0;
}

export function visibleFieldKeys(fields: readonly Field[], values: FormValues): Set<string> {
  const placed = placedFieldsOf(fields);
  const byKey = new Map(placed.map((entry) => [entry.field.key, entry]));
  const visibility = new Map<string, boolean>();

  const effectiveValue = (key: string): unknown => {
    const entry = byKey.get(key);
    if (!entry || !isVisible(entry, new Set())) return undefined;
    const value = values[key];
    return value === undefined && 'default' in entry.field ? entry.field.default : value;
  };

  function isVisible(entry: PlacedField, visiting: Set<string>): boolean {
    const known = visibility.get(entry.field.key);
    if (known !== undefined) return known;
    if (visiting.has(entry.field.key)) return false;
    visiting.add(entry.field.key);
    const visible = entry.conditions.every((condition) => {
      const controller = byKey.get(condition.field);
      if (!controller || !isVisible(controller, visiting)) return false;
      return holds(condition, effectiveValue(condition.field));
    });
    visibility.set(entry.field.key, visible);
    return visible;
  }

  return new Set(placed.filter((entry) => isVisible(entry, new Set())).map((entry) => entry.field.key));
}

function levelSchema(fields: readonly Field[], listItem: boolean): z.ZodType<FormValues> {
  const valueFields = placedFieldsOf(fields)
    .map(({ field }) => field)
    .filter((field): field is ValueField => field.type !== 'info' && field.type !== 'button');
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    valueFields.map((field) => [field.key, valueSchema(field).optional()])
  );
  if (listItem) shape.id = z.string().min(1).max(64).optional();

  const dropHidden = (raw: unknown): unknown => {
    if (!isPlainObject(raw)) return raw;
    const visible = visibleFieldKeys(fields, raw);
    const kept: FormValues = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = valueFields.find((candidate) => candidate.key === key);
      if (field && !visible.has(key)) continue;
      if (value === null) continue;
      if (field && typeof value === 'string' && value.trim() === '' && field.type !== 'radio') continue;
      kept[key] = value;
    }
    return kept;
  };

  return z.preprocess(
    dropHidden,
    z.object(shape).superRefine((values, ctx) => {
      const visible = visibleFieldKeys(fields, values);
      for (const field of valueFields) {
        if (!('required' in field) || field.required !== true || !visible.has(field.key)) continue;
        if (isMissing(values[field.key])) ctx.addIssue({ code: 'custom', path: [field.key], message: 'is required' });
      }
    })
  ) as z.ZodType<FormValues>;
}

export function formValuesSchema(fields: readonly Field[]): z.ZodType<FormValues> {
  return levelSchema(fields, false);
}

export function missingRequiredFieldKeys(fields: readonly Field[], values: FormValues): string[] {
  const visible = visibleFieldKeys(fields, values);
  return placedFieldsOf(fields)
    .map(({ field }) => field)
    .filter((field) => 'required' in field && field.required === true && visible.has(field.key))
    .filter((field) => isMissing(values[field.key]))
    .map((field) => field.key);
}

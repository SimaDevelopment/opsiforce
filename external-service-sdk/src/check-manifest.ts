import type { z } from 'zod';

import type { Field, FieldType } from './fields.ts';
import { templateVariablesOf } from './info-template.ts';
import { manifestLimits, serviceManifestSchema, type ServiceManifest } from './manifest.ts';

const utf8 = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

export interface ManifestProblem {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ManifestCheck {
  ok: boolean;
  manifest?: ServiceManifest;
  problems: ManifestProblem[];
}

type Path = (string | number)[];

type FormName = 'serviceForm' | 'projectForm';

interface PlacedField {
  field: Field;
  path: Path;
}

type KeyedField = Exclude<Field, { type: 'section' }>;

const valueFieldTypes = new Set<FieldType>([
  'text',
  'textarea',
  'number',
  'toggle',
  'radio',
  'select',
  'multiselect',
  'secret',
  'list',
  'keyValue',
]);
const templateFieldTypes = new Set<FieldType>(['text', 'textarea', 'number', 'toggle', 'radio', 'select']);
const reservedListItemKeys = new Set(['id']);

export function formatProblemPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => {
      if (typeof segment === 'number') return `[${segment}]`;
      const key = String(segment);
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    })
    .join('')
    .replace(/^\./, '');
}

export class ProblemList {
  readonly problems: ManifestProblem[] = [];

  error(path: Path, message: string): void {
    this.problems.push({ severity: 'error', path: formatProblemPath(path), message });
  }

  warning(path: Path, message: string): void {
    this.problems.push({ severity: 'warning', path: formatProblemPath(path), message });
  }

  get hasErrors(): boolean {
    return this.problems.some((problem) => problem.severity === 'error');
  }
}

export function checkServiceManifest(input: unknown): ManifestCheck {
  const problems = new ProblemList();
  const bytes = utf8ByteLength(JSON.stringify(input) ?? '');
  if (bytes > manifestLimits.maxManifestBytes) {
    problems.error([], `service.json is ${bytes} bytes; the limit is ${manifestLimits.maxManifestBytes}`);
    return { ok: false, problems: problems.problems };
  }

  const parsed = serviceManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reportZodIssue(problems, issue);
    return { ok: false, problems: problems.problems };
  }

  checkForms(parsed.data, problems);
  return { ok: !problems.hasErrors, manifest: parsed.data, problems: problems.problems };
}

export function reportZodIssue(problems: ProblemList, issue: z.core.$ZodIssue): void {
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const closest = issue.errors.reduce((best, errors) => (errors.length < best.length ? errors : best));
    for (const nested of closest) reportZodIssue(problems, { ...nested, path: [...issue.path, ...nested.path] });
    return;
  }
  if (issue.code === 'invalid_key') {
    for (const nested of issue.issues) problems.error(issue.path as Path, nested.message);
    return;
  }
  problems.error(issue.path as Path, issue.message);
}

function flattenLevel(fields: readonly Field[], path: Path): PlacedField[] {
  return fields.flatMap((field, index): PlacedField[] => {
    const fieldPath = [...path, index];
    const nested = field.type === 'section' ? flattenLevel(field.fields, [...fieldPath, 'fields']) : [];
    return [{ field, path: fieldPath }, ...nested];
  });
}

function keyedFields(placed: PlacedField[]): Map<string, KeyedField> {
  const keyed = new Map<string, KeyedField>();
  for (const { field } of placed) {
    if (field.type !== 'section' && !keyed.has(field.key)) keyed.set(field.key, field);
  }
  return keyed;
}

function topLevelFields(fields: readonly Field[] | undefined): Map<string, KeyedField> {
  return keyedFields(flattenLevel(fields ?? [], []));
}

export function checkForms(
  manifest: Pick<ServiceManifest, 'serviceForm' | 'projectForm'>,
  problems: ProblemList
): void {
  const serviceFields = topLevelFields(manifest.serviceForm);
  for (const form of ['serviceForm', 'projectForm'] as const) {
    const placed = flattenLevel(manifest[form] ?? [], [form]);
    checkLevel(placed, { form, inItem: false, serviceFields }, problems);
  }
}

interface LevelContext {
  form: FormName;
  inItem: boolean;
  serviceFields: Map<string, KeyedField>;
}

function checkLevel(placed: PlacedField[], context: LevelContext, problems: ProblemList): void {
  const keyed = keyedFields(placed);
  const seen = new Set<string>();

  for (const { field, path } of placed) {
    if (field.visibleWhen)
      checkFieldReference(field.visibleWhen.field, field, keyed, [...path, 'visibleWhen'], problems);
    if (field.type === 'section') continue;

    if (seen.has(field.key)) problems.error([...path, 'key'], `key "${field.key}" is used twice at this level`);
    seen.add(field.key);
    if (context.inItem && reservedListItemKeys.has(field.key)) {
      problems.error([...path, 'key'], `"${field.key}" is reserved: the platform assigns each list item its id`);
    }
    if (field.was !== undefined && keyed.has(field.was)) {
      problems.error([...path, 'was'], `was names "${field.was}", which is still a field at this level`);
    }

    if (valueFieldTypes.has(field.type) && !('label' in field && field.label)) {
      problems.warning(
        [...path, 'label'],
        `"${field.key}" has no label, so people see its key "${field.key}" in the form and in refusals`
      );
    }

    checkFieldRules(field, path, keyed, context, problems);
  }
}

function checkFieldReference(
  key: string,
  owner: Field,
  keyed: Map<string, KeyedField>,
  path: Path,
  problems: ProblemList
): void {
  const target = keyed.get(key);
  if (!target) {
    problems.error(path, `"${key}" is not a field at the same level`);
  } else if (owner.type !== 'section' && target === owner) {
    problems.error(path, 'a field cannot refer to itself');
  } else if (!valueFieldTypes.has(target.type)) {
    problems.error(path, `"${key}" is a ${target.type} field and holds no value`);
  }
}

function checkFieldRules(
  field: KeyedField,
  path: Path,
  keyed: Map<string, KeyedField>,
  context: LevelContext,
  problems: ProblemList
): void {
  switch (field.type) {
    case 'text':
    case 'textarea':
      checkTextValidate(field.validate, [...path, 'validate'], problems);
      if (field.type === 'text' && field.generate && field.default !== undefined) {
        problems.error([...path, 'default'], 'a generated field cannot also have a default');
      }
      break;
    case 'number':
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        problems.error([...path, 'min'], 'min is greater than max');
      }
      break;
    case 'radio':
    case 'select':
    case 'multiselect':
      checkOptions(field, path, keyed, context, problems);
      if (field.type === 'multiselect' && field.minItems !== undefined && field.maxItems !== undefined) {
        if (field.minItems > field.maxItems) problems.error([...path, 'minItems'], 'minItems is greater than maxItems');
      }
      break;
    case 'info':
      checkInfo(field, path, keyed, context, problems);
      break;
    case 'list': {
      const itemPlaced = flattenLevel(field.item, [...path, 'item']);
      checkLevel(itemPlaced, { ...context, inItem: true }, problems);
      break;
    }
    case 'toggle':
    case 'secret':
    case 'keyValue':
    case 'button':
      break;
  }
}

function checkTextValidate(
  validate: { minLength?: number; maxLength?: number; format?: string; allowHttp?: boolean } | undefined,
  path: Path,
  problems: ProblemList
): void {
  if (!validate) return;
  if (validate.minLength !== undefined && validate.maxLength !== undefined && validate.minLength > validate.maxLength) {
    problems.error([...path, 'minLength'], 'minLength is greater than maxLength');
  }
  if (validate.allowHttp !== undefined && validate.format !== 'url') {
    problems.error([...path, 'allowHttp'], 'allowHttp applies only to format "url"');
  }
}

function checkOptions(
  field: Extract<KeyedField, { type: 'radio' | 'select' | 'multiselect' }>,
  path: Path,
  keyed: Map<string, KeyedField>,
  context: LevelContext,
  problems: ProblemList
): void {
  const options = field.options;
  const optionsPath = [...path, 'options'];
  if (Array.isArray(options)) {
    const values = new Set<string>();
    options.forEach((option, index) => {
      if (values.has(option.value))
        problems.error([...optionsPath, index, 'value'], `option "${option.value}" is listed twice`);
      values.add(option.value);
    });
    const defaults = field.default === undefined ? [] : Array.isArray(field.default) ? field.default : [field.default];
    for (const value of defaults) {
      if (!values.has(value)) problems.error([...path, 'default'], `default "${value}" is not one of the options`);
    }
    return;
  }
  if ('call' in options) {
    options.dependsOn?.forEach((key, index) =>
      checkFieldReference(key, field, keyed, [...optionsPath, 'dependsOn', index], problems)
    );
    return;
  }
  if (context.form !== 'projectForm') {
    problems.error(
      [...optionsPath, 'serviceConfiguration'],
      'serviceConfiguration options exist only in the Project form'
    );
    return;
  }
  const list = context.serviceFields.get(options.serviceConfiguration);
  if (!list || list.type !== 'list') {
    problems.error(
      [...optionsPath, 'serviceConfiguration'],
      `"${options.serviceConfiguration}" is not a list field of the Service form`
    );
    return;
  }
  const itemFields = topLevelFields(list.item);
  if (!itemFields.has(options.labelKey)) {
    problems.error([...optionsPath, 'labelKey'], `"${options.labelKey}" is not a field of the "${list.key}" items`);
  }
}

function checkInfo(
  field: Extract<KeyedField, { type: 'info' }>,
  path: Path,
  keyed: Map<string, KeyedField>,
  context: LevelContext,
  problems: ProblemList
): void {
  const sources = [field.text, field.template, field.call].filter((source) => source !== undefined);
  if (sources.length !== 1) {
    problems.error(path, 'an info field takes exactly one of text, template or call');
  }
  if (field.template === undefined) return;
  const templatePath = [...path, 'template'];
  for (const variable of templateVariablesOf(field.template)) {
    if (variable === 'webhookUrl') continue;
    const serviceKey = /^serviceConfiguration\.(.+)$/.exec(variable)?.[1];
    if (serviceKey !== undefined) {
      if (context.form !== 'projectForm') {
        problems.error(templatePath, `{{${variable}}}: serviceConfiguration variables exist only in the Project form`);
      } else {
        checkTemplateField(
          variable,
          context.serviceFields.get(serviceKey),
          'is not a Service form field',
          templatePath,
          problems
        );
      }
      continue;
    }
    const message = 'is not a field at the same level, serviceConfiguration.<key> or webhookUrl';
    checkTemplateField(variable, keyed.get(variable), message, templatePath, problems);
  }
}

function checkTemplateField(
  variable: string,
  field: KeyedField | undefined,
  missingMessage: string,
  path: Path,
  problems: ProblemList
): void {
  if (!field) {
    problems.error(path, `{{${variable}}} ${missingMessage}`);
  } else if (!templateFieldTypes.has(field.type)) {
    problems.error(path, `{{${variable}}} is a ${field.type} field; a template shows only plain single values`);
  }
}

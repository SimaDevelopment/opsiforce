import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk';
import { valueFieldsOf, type ValueField } from '@opsiforce/external-service-sdk/platform';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

export type FieldChangeKind = 'added' | 'removed' | 'renamed' | 'changed';

export type FieldAspect = 'type' | 'default' | 'required' | 'options' | 'limits' | 'item fields';

export interface FieldChange {
  key: string;
  label: string;
  change: FieldChangeKind;
  from?: string;
  aspects: FieldAspect[];
  default?: unknown;
  itemChanges?: FieldChange[];
}

export interface FormChanges {
  serviceForm: FieldChange[];
  projectForm: FieldChange[];
}

function defaultOf(field: ValueField): unknown {
  return 'default' in field ? field.default : undefined;
}

function wasOf(field: ValueField): string | undefined {
  return 'was' in field && typeof field.was === 'string' ? field.was : undefined;
}

function isRequired(field: ValueField): boolean {
  return 'required' in field && field.required === true;
}

function optionsOf(field: ValueField): unknown {
  return 'options' in field ? field.options : undefined;
}

const LIMIT_PROPERTIES = ['validate', 'min', 'max', 'integer', 'step', 'minItems', 'maxItems'] as const;

function limitsOf(field: ValueField): Record<string, unknown> {
  return Object.fromEntries(
    LIMIT_PROPERTIES.flatMap((property) =>
      property in field ? [[property, (field as Record<string, unknown>)[property]]] : []
    )
  );
}

function itemChangesBetween(before: ValueField, after: ValueField): FieldChange[] {
  return before.type === 'list' && after.type === 'list' ? formDiff(before.item, after.item) : [];
}

function sameJson(left: unknown, right: unknown): boolean {
  return computeManifestHash(left ?? null) === computeManifestHash(right ?? null);
}

function aspectsBetween(before: ValueField, after: ValueField, itemChanges: readonly FieldChange[]): FieldAspect[] {
  const checks: [FieldAspect, boolean][] = [
    ['type', before.type !== after.type],
    ['default', !sameJson(defaultOf(before), defaultOf(after))],
    ['required', isRequired(before) !== isRequired(after)],
    ['options', !sameJson(optionsOf(before), optionsOf(after))],
    ['limits', !sameJson(limitsOf(before), limitsOf(after))],
    ['item fields', itemChanges.length > 0],
  ];
  return checks.filter(([, changed]) => changed).map(([aspect]) => aspect);
}

function withItemChanges(itemChanges: FieldChange[]): Pick<FieldChange, 'itemChanges'> {
  return itemChanges.length === 0 ? {} : { itemChanges };
}

function withDefault(field: ValueField): Pick<FieldChange, 'default'> {
  const value = defaultOf(field);
  return value === undefined ? {} : { default: value };
}

export function formDiff(base: readonly Field[] | null, next: readonly Field[]): FieldChange[] {
  const before = new Map(valueFieldsOf(base ?? []).map((field) => [field.key, field]));
  const after = valueFieldsOf(next);
  const carried = new Set<string>();
  const changes: FieldChange[] = [];
  for (const field of after) {
    const label = field.label ?? field.key;
    const same = before.get(field.key);
    const was = wasOf(field);
    const renamedFrom = same === undefined && was !== undefined ? before.get(was) : undefined;
    const previous = same ?? renamedFrom;
    if (previous === undefined) {
      changes.push({ key: field.key, label, change: 'added', aspects: [], ...withDefault(field) });
      continue;
    }
    carried.add(previous.key);
    const itemChanges = itemChangesBetween(previous, field);
    const aspects = aspectsBetween(previous, field, itemChanges);
    const details = { aspects, ...withDefault(field), ...withItemChanges(itemChanges) };
    if (renamedFrom) {
      changes.push({ key: field.key, label, change: 'renamed', from: renamedFrom.key, ...details });
    } else if (aspects.length > 0) {
      changes.push({ key: field.key, label, change: 'changed', ...details });
    }
  }
  for (const [key, field] of before) {
    if (!carried.has(key)) changes.push({ key, label: field.label ?? key, change: 'removed', aspects: [] });
  }
  return changes;
}

export function formChanges(base: ServiceManifest | null, next: ServiceManifest): FormChanges {
  return {
    serviceForm: formDiff(base?.serviceForm ?? null, next.serviceForm ?? []),
    projectForm: formDiff(base?.projectForm ?? null, next.projectForm ?? []),
  };
}

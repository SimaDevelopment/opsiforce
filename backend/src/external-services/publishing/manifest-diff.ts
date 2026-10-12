import type { InputSchema, OperationKind, ServiceManifest } from '@opsiforce/external-service-sdk';
import { boundInputsOf } from '@opsiforce/external-service-sdk/platform';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

export type ManifestChange = 'added' | 'changed' | 'removed' | 'unchanged';

export type ChangedAspect = 'kind' | 'input' | 'bounds' | 'title' | 'description';

export interface OperationChange {
  name: string;
  kind: OperationKind;
  change: ManifestChange;
  aspects: ChangedAspect[];
}

export interface EventChange {
  type: string;
  change: ManifestChange;
  aspects: ChangedAspect[];
}

export interface ManifestDiff {
  operations: OperationChange[];
  events: EventChange[];
}

interface ComparedItem {
  kind?: OperationKind;
  title?: string;
  description: string;
  schema: InputSchema;
}

type Defs = Record<string, InputSchema>;

const DEFS_REF_PREFIX = '#/$defs/';

function sameJson(left: unknown, right: unknown): boolean {
  return computeManifestHash(left ?? null) === computeManifestHash(right ?? null);
}

function shapeOf(schema: unknown, defs: Defs, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => shapeOf(entry, defs, seen));
  if (typeof schema !== 'object' || schema === null) return schema;
  const { $ref, boundTo: _boundTo, ...rest } = schema as InputSchema;
  if (typeof $ref === 'string' && $ref.startsWith(DEFS_REF_PREFIX) && !seen.has($ref)) {
    return shapeOf(defs[$ref.slice(DEFS_REF_PREFIX.length)], defs, new Set([...seen, $ref]));
  }
  return Object.fromEntries(
    Object.entries($ref === undefined ? rest : { ...rest, $ref }).map(([key, value]) => [
      key,
      shapeOf(value, defs, seen),
    ])
  );
}

function boundsOf(item: ComparedItem, manifest: ServiceManifest) {
  return boundInputsOf(item.schema, manifest.$defs)
    .map((input) => ({ ...input, definition: manifest.bounds?.[input.bound] ?? null }))
    .toSorted((left, right) => left.pointer.localeCompare(right.pointer));
}

function aspectsBetween(
  before: ComparedItem,
  beforeManifest: ServiceManifest,
  after: ComparedItem,
  afterManifest: ServiceManifest
): ChangedAspect[] {
  const checks: [ChangedAspect, boolean][] = [
    ['kind', before.kind !== after.kind],
    [
      'input',
      !sameJson(shapeOf(before.schema, beforeManifest.$defs ?? {}), shapeOf(after.schema, afterManifest.$defs ?? {})),
    ],
    ['bounds', !sameJson(boundsOf(before, beforeManifest), boundsOf(after, afterManifest))],
    ['title', (before.title ?? null) !== (after.title ?? null)],
    ['description', before.description !== after.description],
  ];
  return checks.filter(([, changed]) => changed).map(([aspect]) => aspect);
}

function itemChanges<T extends ComparedItem>(
  base: ServiceManifest | null,
  next: ServiceManifest,
  itemsOf: (manifest: ServiceManifest) => Record<string, T>
): { key: string; item: T; change: ManifestChange; aspects: ChangedAspect[] }[] {
  const before = base ? itemsOf(base) : {};
  const after = itemsOf(next);
  const present = Object.entries(after).map(([key, item]) => {
    const previous = before[key];
    if (!base || previous === undefined) return { key, item, change: 'added' as const, aspects: [] };
    const aspects = aspectsBetween(previous, base, item, next);
    return { key, item, change: aspects.length > 0 ? ('changed' as const) : ('unchanged' as const), aspects };
  });
  const removed = Object.entries(before)
    .filter(([key]) => after[key] === undefined)
    .map(([key, item]) => ({ key, item, change: 'removed' as const, aspects: [] }));
  return [...present, ...removed];
}

function operationsOf(manifest: ServiceManifest): Record<string, ComparedItem & { kind: OperationKind }> {
  return Object.fromEntries(
    Object.entries(manifest.operations ?? {}).map(([name, operation]) => [
      name,
      { kind: operation.kind, title: operation.title, description: operation.description, schema: operation.input },
    ])
  );
}

function eventsOf(manifest: ServiceManifest): Record<string, ComparedItem> {
  return Object.fromEntries(
    Object.entries(manifest.events ?? {}).map(([type, event]) => [
      type,
      { title: event.title, description: event.description, schema: event.data },
    ])
  );
}

export function manifestDiff(base: ServiceManifest | null, next: ServiceManifest): ManifestDiff {
  return {
    operations: itemChanges(base, next, operationsOf).map(({ key, item, change, aspects }) => ({
      name: key,
      kind: item.kind,
      change,
      aspects,
    })),
    events: itemChanges(base, next, eventsOf).map(({ key, change, aspects }) => ({ type: key, change, aspects })),
  };
}

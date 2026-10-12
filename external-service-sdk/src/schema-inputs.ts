import type { InputSchema } from './input-schema.ts';

export interface SchemaInput {
  pointer: string;
  bound: string | null;
}

export interface BoundInput extends SchemaInput {
  bound: string;
}

const defsRefPrefix = '#/$defs/';

function childrenOf(schema: InputSchema, pointer: string): [InputSchema, string][] {
  const children: [InputSchema, string][] = [];
  for (const [key, property] of Object.entries(schema.properties ?? {})) children.push([property, `${pointer}/${key}`]);
  if (schema.items !== undefined) children.push([schema.items, `${pointer}/*`]);
  if (typeof schema.additionalProperties === 'object') children.push([schema.additionalProperties, `${pointer}/*`]);
  for (const alternative of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) children.push([alternative, pointer]);
  return children;
}

export function schemaInputsOf(
  schema: InputSchema | undefined,
  defs: Record<string, InputSchema> = {},
  pointer = '',
  seen: ReadonlySet<string> = new Set()
): SchemaInput[] {
  if (typeof schema !== 'object' || schema === null) return [];
  if (schema.$ref?.startsWith(defsRefPrefix)) {
    if (seen.has(schema.$ref)) return [];
    const target = defs[schema.$ref.slice(defsRefPrefix.length)];
    return schemaInputsOf(target, defs, pointer, new Set([...seen, schema.$ref]));
  }
  const children = childrenOf(schema, pointer);
  const own: SchemaInput[] =
    schema.boundTo !== undefined || children.length === 0
      ? [{ pointer: pointer || '/', bound: schema.boundTo ?? null }]
      : [];
  return [...own, ...children.flatMap(([child, childPointer]) => schemaInputsOf(child, defs, childPointer, seen))];
}

export function boundInputsOf(schema: InputSchema | undefined, defs: Record<string, InputSchema> = {}): BoundInput[] {
  return schemaInputsOf(schema, defs).filter((input): input is BoundInput => input.bound !== null);
}
